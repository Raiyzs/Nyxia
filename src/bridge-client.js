'use strict';
// bridge-client.js — Nyxia's client for claude-bridge's harness-level scoped
// tool endpoint (claude-bridge/server.js, POST /mcp). Stateless JSON-RPC over
// a single fetch — same shape as krix-memory.js's _mcpCall to krix-brain's own
// MCP daemon. Deliberately no @modelcontextprotocol/sdk: the SDK is ESM-only
// and this process is CJS (same reasoning krix-memory.js already documents),
// and a single-call tool invocation needs no session handshake anyway.
//
// Scope (which tools, which paths) is enforced server-side by claude-bridge
// against krix-brain/agents/nyxia.yaml's tool_scope — this client only carries
// the bearer token and surfaces whatever claude-bridge decides, including
// rejections.

const BRIDGE_URL = 'http://127.0.0.1:3456/mcp';
const TIMEOUT_MS = 15000;

let _id = 0;

// Returns { text, isError } — callers that only ever want display text (the
// three wrappers below) unwrap .text; bridgeRunCommand needs .isError too, to
// tell a failed command apart from a successful one that just printed text.
async function _bridgeCall(tool, args, token) {
  if (!token) return { text: 'Bridge token not configured — set keys.bridgeTokenNyxia in nyxia-config.json.', isError: true };
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++_id,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!data) return { text: `Bridge call failed: HTTP ${res.status}`, isError: true };
    if (data.error) return { text: `Bridge denied: ${data.error.message}`, isError: true };
    const text = (data.result?.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    return { text: text || '(empty)', isError: !!data.result?.isError };
  } catch (e) {
    return { text: `Bridge unreachable: ${e.message}`, isError: true };
  }
}

async function bridgeReadFile(path, token) {
  return (await _bridgeCall('read_file', { path }, token)).text;
}

async function bridgeListFiles(path, token, depth) {
  return (await _bridgeCall('list_files', { path, depth }, token)).text;
}

async function bridgeOpenFile(path, token, app) {
  return (await _bridgeCall('open_in_vscode', app ? { path, app } : { path }, token)).text;
}

// Same shape shell.js's old local executeShell() returned, so formatResult()
// and every existing 'shell' tool call site keep working unchanged — only
// where the command actually runs changes (claude-bridge's scoped run_command,
// blocklist + cwd-scope checked server-side, instead of an unscoped local exec).
async function bridgeRunCommand(cmd, token, cwd) {
  const r = await _bridgeCall('run_command', { command: cmd, cwd }, token);
  return {
    stdout: r.isError ? '' : r.text,
    stderr: r.isError ? r.text : '',
    code:   r.isError ? 1 : 0,
    error:  null,
  };
}

module.exports = { bridgeReadFile, bridgeListFiles, bridgeOpenFile, bridgeRunCommand };
