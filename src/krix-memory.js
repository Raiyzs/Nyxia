'use strict';
// krix-memory.js — KRIX-BRAIN HTTP client for Nyxia's unified memory.
// Talks to api.py on port 7421. All calls are fire-and-forget safe — falls
// back silently if the API is not running.

const KRIX_API = 'http://127.0.0.1:7421';
const TIMEOUT_MS = 5000;

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

module.exports = { writeEntry, searchEntries, searchBrain, writeFile, isAvailable };
