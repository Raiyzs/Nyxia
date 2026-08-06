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

async function _bridgeCall(tool, args, token) {
  if (!token) return 'Bridge token not configured — set keys.bridgeTokenNyxia in nyxia-config.json.';
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
    if (!data) return `Bridge call failed: HTTP ${res.status}`;
    if (data.error) return `Bridge denied: ${data.error.message}`;
    const text = (data.result?.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    return text || '(empty)';
  } catch (e) {
    return `Bridge unreachable: ${e.message}`;
  }
}

function bridgeReadFile(path, token) {
  return _bridgeCall('read_file', { path }, token);
}

function bridgeListFiles(path, token, depth) {
  return _bridgeCall('list_files', { path, depth }, token);
}

function bridgeOpenFile(path, token) {
  return _bridgeCall('open_in_vscode', { path }, token);
}

module.exports = { bridgeReadFile, bridgeListFiles, bridgeOpenFile };
