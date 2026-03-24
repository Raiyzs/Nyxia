// lance-memory.js — LanceDB vector memory for Nyxia's reflections
// Lazy-loads @xenova/transformers on first use (no startup delay).
// Used by main.js to write reflections and query them semantically.
// graph-memory.js runs alongside: LanceDB = similarity, Kùzu = relationships.

const path        = require('path');
const os          = require('os');
const fs          = require('fs');
const graphMemory = require('./graph-memory');

const DB_PATH = path.join(os.homedir(), '.config', 'Nyxia', 'databases', 'memory');
const TABLE   = 'reflections';
const MODEL   = 'Xenova/all-MiniLM-L6-v2'; // must match migration script

let _table    = null;
let _embedder = null;

async function getEmbedder() {
  if (_embedder) return _embedder;
  const { pipeline } = await import('@xenova/transformers');
  _embedder = await pipeline('feature-extraction', MODEL);
  return _embedder;
}

async function embed(text) {
  const e   = await getEmbedder();
  const out = await e(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

async function getTable() {
  if (_table) return _table;
  try {
    fs.mkdirSync(DB_PATH, { recursive: true });
    const lancedb = require('vectordb');
    const db      = await lancedb.connect(DB_PATH);
    const names   = await db.tableNames();
    if (!names.includes(TABLE)) return null; // not yet migrated
    _table = await db.openTable(TABLE);
    return _table;
  } catch (e) {
    console.error('[lance-memory] getTable error:', e.message);
    return null;
  }
}

/**
 * Write a new reflection to LanceDB.
 * @param {string} text  — dated reflection string ("2026-03-18: I notice I...")
 */
async function writeReflection(text, callOllama = null) {
  try {
    const vector = await embed(text);
    const date   = new Date().toISOString();
    const row    = { vector, text, type: 'reflection', date };
    let table    = await getTable();
    if (table) {
      await table.add([row]);
    } else {
      // First write — create table
      fs.mkdirSync(DB_PATH, { recursive: true });
      const lancedb = require('vectordb');
      const db      = await lancedb.connect(DB_PATH);
      _table        = await db.createTable(TABLE, [row]);
    }
    // Sync node to Kùzu graph (fire and forget)
    graphMemory.writeNode(text, 'reflection', date).then(async () => {
      if (callOllama) {
        const related = await queryRelevant(text, 3);
        graphMemory.inferEdges(text, related, callOllama);
      }
    }).catch(() => {});
  } catch (e) {
    console.error('[lance-memory] writeReflection error:', e.message);
  }
}

/**
 * Query most semantically relevant reflections for the given context.
 * @param {string} contextStr — current context / topic to query against
 * @param {number} limit      — max results (default 8)
 * @returns {Promise<string[]>} — array of reflection text strings
 */
async function queryRelevant(contextStr = '', limit = 8) {
  try {
    const table = await getTable();
    if (!table) return [];
    const query   = contextStr.trim() || 'identity self beliefs nyxia growth experience';
    const vector  = await embed(query);
    const results = await table.search(vector).limit(limit).execute();
    return results.map(r => r.text);
  } catch (e) {
    console.error('[lance-memory] queryRelevant error:', e.message);
    return [];
  }
}

/**
 * Store a feedback correction. Surfaces when similar queries arrive in future.
 * @param {string} query      — the original user question
 * @param {string} response   — what Nyxia said
 * @param {string} correction — what she should have said
 */
async function writeFeedback(query, response, correction) {
  const text = `CORRECTION: When asked "${query.slice(0, 200)}", I responded incorrectly. The correct answer is: ${correction}`;
  try {
    const date   = new Date().toISOString();
    const vector = await embed(text);
    const row    = { vector, text, type: 'correction', date };
    let table    = await getTable();
    if (table) {
      await table.add([row]);
    } else {
      fs.mkdirSync(DB_PATH, { recursive: true });
      const lancedb = require('vectordb');
      const db      = await lancedb.connect(DB_PATH);
      _table        = await db.createTable(TABLE, [row]);
    }
    // Sync correction node to Kùzu graph (fire and forget)
    graphMemory.writeNode(text, 'correction', date).catch(() => {});
    console.log('[lance-memory] feedback saved:', text.slice(0, 80));
  } catch (e) {
    console.error('[lance-memory] writeFeedback error:', e.message);
  }
}

module.exports = { writeReflection, queryRelevant, writeFeedback };
