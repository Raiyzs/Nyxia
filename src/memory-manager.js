'use strict';

/**
 * memory-manager.js — Unified coordinator for all of Nyxia's memory stores.
 *
 * Replaces direct calls to lance/graph/krix/beliefs scattered across prompt-builder.
 * Priority order: beliefs → lance (episodic) → graph (relational) → krix (cross-project)
 * Deduplicates, budget-caps, and routes long-horizon queries to Krix-Brain.
 */

const lanceMemory  = require('./lance-memory');
const graphMemory  = require('./graph-memory');
const krixMemory   = require('./krix-memory');
const { getSelfBelief } = require('./brain-soul');

// n-gram dedup: drop entry if it shares > 70% of 6-char shingles with an already-kept entry
function _isDuplicate(text, seen) {
  const shingles = s => {
    const r = new Set();
    const n = s.toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < n.length - 5; i++) r.add(n.slice(i, i + 6));
    return r;
  };
  const a = shingles(text);
  if (a.size === 0) return false;
  for (const s of seen) {
    const b = shingles(s);
    const inter = [...a].filter(x => b.has(x)).length;
    if (inter / Math.max(a.size, b.size, 1) > 0.70) return true;
  }
  return false;
}

function _truncateToSentence(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut  = text.slice(0, maxChars);
  const last = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('!\n'), cut.lastIndexOf('?\n'), cut.lastIndexOf('\n'));
  return last > maxChars * 0.5 ? cut.slice(0, last + 1).trimEnd() : cut.trimEnd();
}

/**
 * Query all memory stores, deduplicate, rank, and return a budget-capped string.
 *
 * @param {string} queryText   — current user message or context snippet
 * @param {object} opts
 * @param {number}  opts.budget       — max characters to return (default 1800)
 * @param {boolean} opts.includeKrix  — query krix-brain (slight latency, default true)
 * @param {boolean} opts.includeGraph — traverse kùzu graph (default true)
 * @param {boolean} opts.includeBeliefs — fetch self-belief sector (default true)
 * @returns {Promise<string>}
 */
async function query(queryText = '', {
  budget       = 1800,
  includeKrix  = true,
  includeGraph = true,
  includeBeliefs = true,
} = {}) {
  const raw = [];

  // 1. Beliefs (self-model — highest salience)
  if (includeBeliefs) {
    try {
      const beliefs = await getSelfBelief(queryText || 'identity self beliefs');
      if (beliefs) raw.push({ text: beliefs, source: 'beliefs' });
    } catch {}
  }

  // 2. LanceDB episodic / reflections
  try {
    const lance = await lanceMemory.queryRelevant(queryText, 6);
    lance.forEach(t => raw.push({ text: t, source: 'lance' }));
  } catch {}

  // 3. Graph — relational chains (skip on fast paths)
  if (includeGraph) {
    try {
      const gCtx = await graphMemory.queryMemoryGraph(queryText);
      if (gCtx) raw.push({ text: gCtx, source: 'graph' });
    } catch {}
  }

  // 4. Krix-Brain — cross-project long-term semantic
  if (includeKrix) {
    try {
      const up = await krixMemory.isAvailable();
      if (up) {
        const hits = await krixMemory.searchEntries(queryText, { namespace: 'nyxia', top_k: 5 });
        hits.forEach(t => raw.push({ text: t, source: 'krix' }));
      }
    } catch {}
  }

  // Per-source budget shares (chars)
  const shares = {
    beliefs: Math.floor(budget * 0.22),
    lance:   Math.floor(budget * 0.38),
    graph:   Math.floor(budget * 0.22),
    krix:    Math.floor(budget * 0.18),
  };

  const seen    = [];
  const chunks  = [];
  let   used    = 0;

  for (const { text, source } of raw) {
    const t = (text || '').trim();
    if (!t || used >= budget) break;
    if (_isDuplicate(t, seen)) continue;
    seen.push(t);

    const cap     = Math.min(shares[source] ?? 200, budget - used);
    const chunk   = _truncateToSentence(t, cap);
    if (!chunk) continue;
    chunks.push(chunk);
    used += chunk.length;
  }

  return chunks.join('\n\n');
}

/**
 * Prune old, low-importance LanceDB entries.
 * Delegates to lance-memory which has direct table access.
 *
 * @param {number} threshold  — importance score cutoff (0–1, default 0.15)
 * @param {number} minAgeDays — only prune entries older than this (default 30)
 */
async function pruneByImportance(threshold = 0.15, minAgeDays = 30) {
  try {
    const removed = await lanceMemory.pruneOldLowImportance(threshold, minAgeDays);
    console.log(`[memory-manager] pruned ${removed} low-importance entries`);
    return removed;
  } catch (e) {
    console.error('[memory-manager] prune error:', e.message);
    return 0;
  }
}

module.exports = { query, pruneByImportance };
