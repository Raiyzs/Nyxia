'use strict';
// krix-memory.js — KRIX-BRAIN HTTP client for Nyxia's unified memory.
// Search goes MCP-first (server.py --http daemon, port 7425, stateless JSON-RPC),
// falling back to api.py REST on port 7421. Writes still go to api.py.
// All calls are fire-and-forget safe — falls back silently if nothing is running.

const KRIX_API = 'http://127.0.0.1:7421';
const KRIX_MCP = 'http://127.0.0.1:7425/mcp/';
const TIMEOUT_MS = 5000;

let _mcpId = 0;

// Call one MCP tool via stateless streamable-HTTP JSON-RPC. Returns the tool's
// text output, or null if the daemon is down or errored.
async function _mcpCall(tool, args) {
  try {
    const res = await fetch(KRIX_MCP, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++_mcpId,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error || data.result?.isError) return null;
    const text = (data.result?.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    return text || null;
  } catch {
    return null;
  }
}

async function _post(endpoint, body) {
  try {
    const res = await fetch(`${KRIX_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Write an episodic memory entry (reflection, correction, anchor, opinion, belief).
 * @param {string} namespace  e.g. 'nyxia/memories' or 'nyxia/beliefs'
 * @param {string} type       'reflection' | 'correction' | 'anchor' | 'opinion' | sector name
 * @param {string} text
 */
async function writeEntry(namespace, type, text) {
  return _post('/write_entry', { namespace, type, text, date: new Date().toISOString() });
}

/**
 * Semantic search across episodic memory entries.
 * @param {string} query
 * @param {object} opts  { namespace, type, top_k }
 * @returns {Promise<string[]>}
 */
async function searchEntries(query, { namespace = null, type = null, top_k = 8 } = {}) {
  const result = await _post('/search_entries', { query, namespace, type, top_k });
  if (!result?.results) return [];
  return result.results.map(r => r.text);
}

/**
 * Semantic search across KRIX-BRAIN knowledge files (projects, soul docs, etc.).
 * @param {string} query
 * @param {object} opts  { namespace, path_prefix, top_k }
 * @returns {Promise<Array<{path, snippet}>>}
 */
async function searchBrain(query, { namespace = null, path_prefix = null, top_k = 5 } = {}) {
  // MCP daemon first (path_prefix is REST-only — skip MCP when it's requested)
  if (!path_prefix) {
    const args = { query, top_k };
    if (namespace) args.namespace = namespace;
    const text = await _mcpCall('search_brain', args);
    if (text) {
      // Format: "[confidence: …]\n### [brain] path (score=…)\n<snippet>\n### …"
      const hits = [];
      for (const block of text.split(/^### /m).slice(1)) {
        const nl = block.indexOf('\n');
        if (nl === -1) continue;
        const header = block.slice(0, nl);
        const m = header.match(/^\[[\w-]+\]\s+(\S+)\s+\(/);
        if (!m) continue;
        hits.push({ path: m[1], snippet: block.slice(nl + 1).trim() });
      }
      if (hits.length) return hits;
    }
  }
  const result = await _post('/search', { query, namespace, path_prefix, top_k });
  if (!result?.results) return [];
  return result.results.map(r => ({ path: r.path, snippet: r.snippet }));
}

/**
 * Write or update a knowledge file in KRIX-BRAIN.
 * @param {string} path     relative path within krix-brain/
 * @param {string} content  full file content
 */
async function writeFile(path, content) {
  return _post('/write_file', { path, content });
}

/**
 * Check if the KRIX-BRAIN API is reachable.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  try {
    const res = await fetch(`${KRIX_API}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Tag jarvis_dispatch() (agent_runner.py) stamps on followups.md entries it
// queues for an uncertain classification — lets us pick those out of the
// same followups list without a second storage mechanism.
const UNCERTAIN_QUEUE_TAG = 'jarvis-uncertain';

/**
 * List pending followups tagged as jarvis-uncertain routing decisions —
 * read-only, via api.py's REST /followups (no MCP round-trip needed for reads).
 * @returns {Promise<Array<{date, text, context}>>}
 */
async function listUncertainFollowups() {
  try {
    const res = await fetch(`${KRIX_API}/followups`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const { pending } = await res.json();
    return (pending || []).filter(p => (p.context || '').includes(UNCERTAIN_QUEUE_TAG));
  } catch {
    return [];
  }
}

/**
 * Mark a followup resolved — write tool, MCP-only (api.py deliberately has
 * no unauthenticated write routes on port 7421).
 * @param {string} textSubstring  distinctive substring of the followup's text
 */
async function resolveFollowup(textSubstring) {
  return _mcpCall('resolve_followup', { text: textSubstring });
}

/**
 * Dispatch a task to a named worker persona via the existing /agent route —
 * the same public path a human picking a worker in the portfolio's Agent
 * Room uses. Not MCP — this one's a normal REST action, already unauthed.
 * @param {string} agent   scout | ava | tom | bobby
 * @param {string} task
 * @param {string} context
 * @returns {Promise<{response: string, agent: string}|null>}
 */
async function dispatchTask(agent, task, context = '') {
  return _post('/agent', { agent, task, context });
}

module.exports = {
  writeEntry, searchEntries, searchBrain, writeFile, isAvailable,
  listUncertainFollowups, resolveFollowup, dispatchTask,
};
