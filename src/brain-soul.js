'use strict';
// ── brain-soul.js — Cortex-First Sector Ownership ─────────────────────────────
// Talks to the Chroma server via raw HTTP (no chromadb npm at require-time —
// the chromadb CJS package interferes with Electron's module loader).
// Chroma server is spawned by main.js ensureChroma() at 127.0.0.1:8769.
//
// API (unchanged — drop-in replacement for JSON version):
//   fireSector(key, payload, intensity)  — write to sector
//   querySector(key, query, limit)       — semantic search
//   getSelfBelief(topic)                 — integrated cortex query
//   migrateFromSelfJson(selfData)        — JSON → Chroma migration

const path = require('path');
const fs   = require('fs');
const http = require('http');
// app is lazy-loaded inside functions to avoid interfering with Electron's module loader at require-time
function getApp() { return require('electron').app; }

const CHROMA_BASE  = 'http://127.0.0.1:8769/api/v2';
const CHROMA_TENANT = 'default_tenant';
const CHROMA_DB     = 'default_database';
const OLLAMA_HOST   = '127.0.0.1';
const OLLAMA_PORT   = 11434;
const EMBED_PRIMARY  = 'nomic-embed-text';
const EMBED_FALLBACK = 'llama3.2:3b';

// ── mainWindow reference (injected from main.js after window creation) ─────────
let _mainWindow = null;
function setMainWindow(mw) { _mainWindow = mw; }

// ── Sector definitions ─────────────────────────────────────────────────────────
const SECTOR_DEFS = {
  prefrontal:     { description: 'Executive control, council arbitration, goal alignment' },
  cortex_left:    { description: 'Streaming language output, logical reasoning' },
  cortex_right:   { description: 'Creative synthesis, spatial awareness, imagination' },
  hippocampus:    { description: 'Reflections, long-term memory, beliefs, identity growth' },
  limbic:         { description: 'Emotional tone, attachment, mood coloring' },
  amygdala_right: { description: 'Curiosity, wonder, desire to understand' },
  amygdala_left:  { description: 'Caution, threat detection, self-preservation instinct' },
  cerebellum:     { description: 'Motor output — speech timing, TTS rhythm, animation' },
  stem:           { description: 'Core vitals — routing heartbeat, system awareness' },
  mirror:         { description: 'Empathy, social observation, mirroring the user' },
};

// ── Chroma HTTP helpers ────────────────────────────────────────────────────────
async function chromaFetch(method, endpoint, body) {
  const url = `${CHROMA_BASE}${endpoint}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Chroma ${method} ${endpoint} → ${res.status}: ${t.slice(0, 80)}`);
  }
  return res.json();
}

// Cache: sector name → collection UUID
const _collUUID = {};

async function getSectorCollection(key) {
  if (_collUUID[key]) return _collUUID[key];

  const base = `/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections`;

  // Try get first
  try {
    const coll = await chromaFetch('GET', `${base}/${key}`);
    _collUUID[key] = coll.id;
    return coll.id;
  } catch(_) {}

  // Create
  const coll = await chromaFetch('POST', base, {
    name: key,
    metadata: { description: SECTOR_DEFS[key]?.description || '' },
  });
  _collUUID[key] = coll.id;
  return coll.id;
}

// ── Ollama embedding ───────────────────────────────────────────────────────────
async function embedText(text) {
  for (const model of [EMBED_PRIMARY, EMBED_FALLBACK]) {
    try {
      const vec = await _ollamaEmbed(text, model);
      if (vec && vec.length > 0) return vec;
    } catch(e) {}
  }
  return null;
}

function _ollamaEmbed(text, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, input: text });
    const req  = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT,
      path: '/api/embed', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          resolve(p.embeddings?.[0] || p.embedding || null);
        } catch(e) { reject(e); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('embed timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── fireSector ─────────────────────────────────────────────────────────────────
function fireSector(key, payload, intensity = 1.0) {
  if (!SECTOR_DEFS[key] || !payload) return key;

  // Visual spike fires immediately — Chroma write follows async
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send('brain-fire', { sector: key, intensity, decay: 0.92 });
  }

  setImmediate(async () => {
    try {
      const uuid   = await getSectorCollection(key);
      const text   = typeof payload === 'string' ? payload
                   : (payload.entry || payload.text || payload.summary || JSON.stringify(payload));
      const vector = await embedText(text);
      const base   = `/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections/${uuid}`;

      await chromaFetch('POST', `${base}/add`, {
        ids:        [`e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`],
        embeddings: vector ? [vector] : undefined,
        metadatas:  [{ time: new Date().toISOString(),
                       topic: payload.topic || payload.type || 'general',
                       raw:   JSON.stringify(payload) }],
        documents:  [text],
      });
    } catch(e) {
      if (!e.message?.includes('heartbeat') && !e.message?.includes('ECONNREFUSED')) {
        console.error(`[brain-soul] fireSector [${key}]:`, e.message);
      }
    }
  });

  return key;
}

// ── querySector ────────────────────────────────────────────────────────────────
async function querySector(key, queryText, limit = 5) {
  try {
    const uuid     = await getSectorCollection(key);
    const base     = `/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections/${uuid}`;
    const countRes = await chromaFetch('GET', `${base}/count`);
    const count    = typeof countRes === 'number' ? countRes : (countRes.count || 0);
    if (count === 0) return [];

    const queryVec = await embedText(queryText);
    if (!queryVec) {
      // Offline: return most recent documents
      const all = await chromaFetch('POST', `${base}/get`, { limit: limit * 2, include: ['documents', 'metadatas'] });
      return (all.documents || []).map((doc, i) => ({ score: 0.5, text: doc, metadata: all.metadatas?.[i] || {} }));
    }

    const results = await chromaFetch('POST', `${base}/query`, {
      query_embeddings: [queryVec],
      n_results: Math.min(limit, count),
      include:   ['metadatas', 'documents', 'distances'],
    });

    return (results.ids?.[0] || []).map((id, i) => ({
      id,
      score:    1 - (results.distances?.[0]?.[i] || 0),
      text:     results.documents?.[0]?.[i] || '',
      metadata: results.metadatas?.[0]?.[i] || {},
    }));
  } catch(e) {
    return []; // Chroma not ready — silently fall back
  }
}

// ── getSelfBelief ──────────────────────────────────────────────────────────────
async function getSelfBelief(topic = 'beliefs identity self') {
  const [hipp, pref, amyg] = await Promise.all([
    querySector('hippocampus',    topic, 5),
    querySector('prefrontal',     topic, 3),
    querySector('amygdala_right', topic, 2),
  ]);

  const all = [
    ...hipp.map(e => ({ ...e, sectorWeight: 0.92 })),
    ...pref.map(e => ({ ...e, sectorWeight: 1.0  })),
    ...amyg.map(e => ({ ...e, sectorWeight: 0.85 })),
  ];
  all.sort((a, b) => ((b.score || 0.5) * b.sectorWeight) - ((a.score || 0.5) * a.sectorWeight));

  const seen = new Set();
  const out  = [];
  for (const e of all) {
    const text = e.text || '';
    const k    = text.slice(0, 60);
    if (!seen.has(k) && text.length > 5) { seen.add(k); out.push(text); }
    if (out.length >= 8) break;
  }
  return out;
}

// ── Migration ──────────────────────────────────────────────────────────────────
async function migrateOldJsonToChroma() {
  const oldDir = path.join(getApp().getPath('userData'), 'brain');
  if (!fs.existsSync(oldDir)) return;
  console.log('[brain-soul] migrating sector JSON → Chroma...');

  for (const key of Object.keys(SECTOR_DEFS)) {
    const jsonPath = path.join(oldDir, `${key}.json`);
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const entries  = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const uuid     = await getSectorCollection(key);
      const base     = `/tenants/${CHROMA_TENANT}/databases/${CHROMA_DB}/collections/${uuid}`;
      const countRes = await chromaFetch('GET', `${base}/count`);
      const count    = typeof countRes === 'number' ? countRes : (countRes.count || 0);
      if (count > 0) { console.log(`[brain-soul] ${key} already migrated`); continue; }

      console.log(`[brain-soul] migrating ${entries.length} entries → ${key}`);
      for (const entry of entries) {
        const text   = typeof entry.data === 'string' ? entry.data
                     : (entry.data?.entry || entry.data?.text || entry.data?.summary || JSON.stringify(entry.data));
        const vector = entry.vector || await embedText(text);
        await chromaFetch('POST', `${base}/add`, {
          ids:        [`mig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`],
          embeddings: vector ? [vector] : undefined,
          metadatas:  [{ time: entry.time || new Date().toISOString(), topic: entry.topic || 'general', raw: JSON.stringify(entry.data) }],
          documents:  [text],
        });
      }
    } catch(e) { console.error(`[brain-soul] migrate error [${key}]:`, e.message); }
  }
  console.log('[brain-soul] migration complete — JSON files kept as backup');
}

function migrateFromSelfJson(selfData) {
  if (selfData?.reflections?.length || fs.existsSync(path.join(getApp().getPath('userData'), 'brain'))) {
    migrateOldJsonToChroma().catch(e => console.error('[brain-soul] migration failed:', e.message));
  }
}

module.exports = { fireSector, querySector, getSelfBelief, migrateFromSelfJson, migrateOldJsonToChroma, SECTOR_DEFS, setMainWindow };
