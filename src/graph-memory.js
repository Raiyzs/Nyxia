// graph-memory.js — Kùzu graph layer alongside LanceDB
// LanceDB = "what's similar?" (vector search)
// Kùzu    = "how does it connect?" (relationship traversal)
//
// Schema:
//   Memory nodes: { id, text, type, date }
//   RELATES_TO edges: { reason } — describes the relationship between two memories

const kuzu   = require('kuzu');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const GRAPH_PATH = path.join(os.homedir(), '.config', 'Nyxia', 'databases', 'memory-graph');

let _db   = null;
let _conn = null;

// ── Internal helpers ──────────────────────────────────────────────────────────

function textToId(text) {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 16);
}

async function getConn() {
  if (_conn) return _conn;
  // Ensure parent dir exists but NOT the graph dir itself — Kùzu creates it
  fs.mkdirSync(path.dirname(GRAPH_PATH), { recursive: true });
  _db   = new kuzu.Database(GRAPH_PATH);
  _conn = new kuzu.Connection(_db);
  await _initSchema();
  return _conn;
}

async function _initSchema() {
  await _conn.query(`
    CREATE NODE TABLE IF NOT EXISTS Memory(
      id   STRING,
      text STRING,
      type STRING,
      date STRING,
      PRIMARY KEY(id)
    )
  `);
  await _conn.query(
    'CREATE REL TABLE IF NOT EXISTS RELATES_TO(FROM Memory TO Memory, reason STRING)'
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write a Memory node. Safe to call on existing nodes (MERGE).
 */
async function writeNode(text, type = 'reflection', date = new Date().toISOString()) {
  try {
    const conn = await getConn();
    const id   = textToId(text);
    const safe = text.replace(/"/g, '\\"').slice(0, 500);
    await conn.query(
      `MERGE (n:Memory {id: "${id}"}) ` +
      `ON CREATE SET n.text = "${safe}", n.type = "${type}", n.date = "${date}"`
    );
    return id;
  } catch (e) {
    console.error('[graph-memory] writeNode error:', e.message);
    return null;
  }
}

/**
 * Write a directed RELATES_TO edge between two memory texts.
 */
async function writeEdge(fromText, toText, reason) {
  try {
    const conn   = await getConn();
    const fromId = textToId(fromText);
    const toId   = textToId(toText);
    const safeR  = (reason || 'related').replace(/"/g, '\\"').slice(0, 200);
    await conn.query(
      `MATCH (a:Memory {id: "${fromId}"}), (b:Memory {id: "${toId}"}) ` +
      `MERGE (a)-[:RELATES_TO {reason: "${safeR}"}]->(b)`
    );
  } catch (e) {
    console.error('[graph-memory] writeEdge error:', e.message);
  }
}

/**
 * Query nodes connected to the node matching anchorText (1-hop).
 * Returns array of { text, type, date, reason } objects.
 */
async function queryConnected(anchorText, limit = 5) {
  try {
    const conn = await getConn();
    const id   = textToId(anchorText);
    const res  = await conn.query(
      `MATCH (a:Memory {id: "${id}"})-[r:RELATES_TO]->(b:Memory) ` +
      `RETURN b.text AS text, b.type AS type, b.date AS date, r.reason AS reason ` +
      `LIMIT ${limit}`
    );
    const rows = await res.getAll();
    // also check reverse direction
    const res2 = await conn.query(
      `MATCH (b:Memory)-[r:RELATES_TO]->(a:Memory {id: "${id}"}) ` +
      `RETURN b.text AS text, b.type AS type, b.date AS date, r.reason AS reason ` +
      `LIMIT ${limit}`
    );
    const rows2 = await res2.getAll();
    return [...rows, ...rows2];
  } catch (e) {
    console.error('[graph-memory] queryConnected error:', e.message);
    return [];
  }
}

/**
 * Full graph query entry point.
 * Given the top LanceDB result text (anchor), find its connected nodes in Kùzu.
 * Returns a formatted string ready for context injection, or null if nothing found.
 *
 * Usage: call after queryRelevant() in lance-memory.js, pass the top result.
 */
async function queryMemoryGraph(anchorText) {
  if (!anchorText) return null;
  try {
    const hops = 2 + Math.floor(Math.random() * 3); // 2, 3, or 4 — human thought wanders
    const chain = [{ text: anchorText, reason: 'seed' }];
    let current = anchorText;

    for (let i = 0; i < hops; i++) {
      const connected = await queryConnected(current, 6);
      if (!connected.length) break;
      const unused = connected.filter(c => !chain.some(n => n.text === c.text));
      if (!unused.length) break;
      const pick = unused[Math.floor(Math.random() * unused.length)];
      chain.push({ text: pick.text, reason: pick.reason });
      current = pick.text;
    }

    if (chain.length < 2) return null;
    const lines = chain.slice(1).map(n => `  • [${n.reason}] ${n.text.slice(0, 120)}`);
    return `Train of thought from "${anchorText.slice(0, 80)}":\n${lines.join('\n')}`;
  } catch (e) {
    console.error('[graph-memory] queryMemoryGraph error:', e.message);
    return null;
  }
}

/**
 * Migrate existing LanceDB rows into Kùzu nodes.
 * Call once at startup with all rows from LanceDB.
 * Safe to call repeatedly — MERGE skips existing nodes.
 */
async function migrateFromLance(rows) {
  if (!rows || !rows.length) return;
  let count = 0;
  for (const row of rows) {
    const id = await writeNode(row.text, row.type || 'reflection', row.date || '');
    if (id) count++;
  }
  console.log(`[graph-memory] migrated ${count}/${rows.length} nodes from LanceDB`);
}

/**
 * Infer and write an edge between a new memory and related existing ones.
 * Called asynchronously after writeReflection — never blocks response.
 * Uses llama3.2:3b to determine relationship type.
 *
 * @param {string} newText       — the new reflection text
 * @param {string[]} relatedTexts — top results from LanceDB for this reflection
 * @param {Function} callOllama  — (prompt) => Promise<string>, injected from main.js
 */
async function inferEdges(newText, relatedTexts, callOllama) {
  if (!relatedTexts || !relatedTexts.length || !callOllama) return;
  const candidates = relatedTexts.slice(0, 3).filter(t => t && t !== newText);
  for (const candidate of candidates) {
    try {
      const prompt =
        `Memory A: "${newText.slice(0, 200)}"\n` +
        `Memory B: "${candidate.slice(0, 200)}"\n` +
        `In 5 words or fewer, what is the relationship from A to B? ` +
        `Examples: "caused", "contradicts", "deepened attachment", "resolved". ` +
        `Return only the relationship phrase, nothing else.`;
      const reason = (await callOllama(prompt)).trim().slice(0, 80);
      if (reason) await writeEdge(newText, candidate, reason);
      console.log(`[graph-memory] edge: "${newText.slice(0,40)}" -[${reason}]-> "${candidate.slice(0,40)}"`);
    } catch (e) {
      console.error('[graph-memory] inferEdges error:', e.message);
    }
  }
}

/**
 * Return total node count — for diagnostics.
 */
async function nodeCount() {
  try {
    const conn = await getConn();
    const res  = await conn.query('MATCH (n:Memory) RETURN count(n) AS c');
    const rows = await res.getAll();
    return rows[0]?.c ?? 0;
  } catch { return 0; }
}

module.exports = { writeNode, writeEdge, queryConnected, queryMemoryGraph, migrateFromLance, inferEdges, nodeCount };
