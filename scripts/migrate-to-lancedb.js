#!/usr/bin/env node
// migrate-to-lancedb.js
// Migrates nyxia-self.json reflections + nyxia-memory.json exchanges into LanceDB.
// Run once from project root: node scripts/migrate-to-lancedb.js

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const NYXIA_DIR  = path.join(os.homedir(), '.config', 'Nyxia');
const SELF_PATH  = path.join(NYXIA_DIR, 'nyxia-self.json');
const MEM_PATH   = path.join(NYXIA_DIR, 'nyxia-memory.json');
const DB_PATH    = path.join(NYXIA_DIR, 'databases', 'memory');

async function embed(pipeline, text) {
  const out = await pipeline(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

async function main() {
  console.log('Loading @xenova/transformers...');
  const { pipeline } = await import('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.log('Embedding model ready (all-MiniLM-L6-v2, 384-dim)');

  // Load source data
  const selfData = JSON.parse(fs.readFileSync(SELF_PATH, 'utf8'));
  const memData  = JSON.parse(fs.readFileSync(MEM_PATH,  'utf8'));

  const reflections = selfData.reflections || [];
  // Only assistant messages of substance (>80 chars) as significant exchanges
  const exchanges = (Array.isArray(memData) ? memData : [])
    .filter(m => m.role === 'assistant' && m.content && m.content.length > 80)
    .slice(-30); // cap at 30 most recent significant exchanges

  console.log(`Reflections to migrate: ${reflections.length}`);
  console.log(`Significant exchanges to migrate: ${exchanges.length}`);

  // Build rows
  const rows = [];

  for (let i = 0; i < reflections.length; i++) {
    const r = reflections[i];
    const text = typeof r === 'string' ? r : (r.text || r.content || JSON.stringify(r));
    const when = typeof r === 'object' && r.date ? r.date : new Date().toISOString();
    process.stdout.write(`  embedding reflection ${i + 1}/${reflections.length}...\r`);
    const vector = await embed(embedder, text);
    rows.push({ vector, text, type: 'reflection', date: when });
  }
  console.log(`\n  reflections embedded`);

  for (let i = 0; i < exchanges.length; i++) {
    const m = exchanges[i];
    process.stdout.write(`  embedding exchange ${i + 1}/${exchanges.length}...\r`);
    const vector = await embed(embedder, m.content);
    rows.push({ vector, text: m.content, type: 'exchange', date: new Date().toISOString() });
  }
  console.log(`\n  exchanges embedded`);

  // Write to LanceDB
  fs.mkdirSync(DB_PATH, { recursive: true });
  const lancedb = require('vectordb');
  const db = await lancedb.connect(DB_PATH);

  const TABLE = 'reflections';
  const tableNames = await db.tableNames();

  let table;
  if (tableNames.includes(TABLE)) {
    console.log(`Table '${TABLE}' exists — appending ${rows.length} rows`);
    table = await db.openTable(TABLE);
    await table.add(rows);
  } else {
    console.log(`Creating table '${TABLE}' with ${rows.length} rows`);
    table = await db.createTable(TABLE, rows);
  }

  const count = await table.countRows();
  console.log(`\nDone. Total rows in LanceDB: ${count}`);
  console.log(`DB path: ${DB_PATH}`);
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
