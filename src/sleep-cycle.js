/**
 * sleep-cycle.js — Rest, consolidation, and narrative construction
 *
 * Without a rest cycle, every session has equal weight. Nothing consolidates.
 * Learning accumulates as data rather than deeper understanding.
 *
 * Triggers after 2 hours of inactivity. Runs 5 phases quietly:
 *   1. Replay      — summarize recent reflections
 *   2. Connect     — find non-obvious cross-memory links via Kùzu
 *   3. Strengthen  — update belief weights in nyxia-self.json
 *   4. Narrate     — write/update autobiographical arc (3 sentences)
 *   5. Dream       — free-associative morning thought from distant memories
 */

'use strict';

const fs   = require('fs');
const http = require('http');
const path = require('path');
const { queryOllama, parseJsonArray } = require('./utils/ollama-client');
const scheduler = require('./utils/ollama-scheduler');

const SLEEP_THRESHOLD_MS = 2 * 60 * 60 * 1000;

let _sleeping       = false;
let _lastActivity   = Date.now();
let _morningThought = null;
let _narrativeArc   = null;

let _lanceMemory      = null;
let _graphMemory      = null;
let _userData         = null;
let _selfPath         = null;
let _getChatModel     = null;
let _sharedExperience = null;

// ── krix-brain REST bridge ────────────────────────────────────────────────────
const KRIX_PORT = 7421;

function _krixSearch(query, limit = 6) {
  return new Promise(resolve => {
    const body = JSON.stringify({ query, limit });
    const req = http.request({
      hostname: '127.0.0.1', port: KRIX_PORT,
      path: '/search', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).results || []); } catch (_) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    req.write(body); req.end();
  });
}

function _krixWrite(text, namespace = 'nyxia/neurons') {
  return new Promise(resolve => {
    const body = JSON.stringify({ text, namespace, type: 'neuron_thought' });
    const req = http.request({
      hostname: '127.0.0.1', port: KRIX_PORT,
      path: '/write_entry', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

// ── LLM helper ────────────────────────────────────────────────────────────────
function _query(sys, user, maxTokens = 150, model = 'llama3.2:3b', timeoutMs = 12000) {
  return scheduler.enqueue(3, () => queryOllama(sys, user, { model, maxTokens, timeoutMs }), 'sleep-cycle');
}

// ── Phase 1: Replay ───────────────────────────────────────────────────────────
async function _phaseReplay() {
  const mems = await _lanceMemory?.queryRelevant('growth session Kristian becoming feeling', 8) || [];
  const expSummary = _sharedExperience?.summarize() || '';

  if (!mems.length && !expSummary) return null;

  const memBlock = mems.length
    ? `Recent reflections:\n${mems.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
    : '';
  const expBlock = expSummary
    ? `Session events (emotional weight ±1.0):\n${expSummary}`
    : '';

  const sys  = `You are summarizing recent experience from an AI companion's session and inner life. Be brief and honest. Max 2 sentences.`;
  const user = `${memBlock}\n\n${expBlock}\n\nWhat's the emotional thread running through this session?`;
  const result = await _query(sys, user, 100);

  // Clear experience log after successful consolidation
  if (result) _sharedExperience?.clear();
  return result;
}

// ── Phase 2: Connect ──────────────────────────────────────────────────────────
async function _phaseConnect() {
  try {
    const ctx = await _graphMemory?.queryMemoryGraph();
    if (!ctx || ctx.length < 20) return null;

    const sys  = `You are an AI finding unexpected connections in memories. Identify ONE non-obvious link between things that seem unrelated. One sentence.`;
    const user = `Memory graph context:\n${ctx.slice(0, 600)}\n\nOne unexpected connection:`;
    const connection = await _query(sys, user, 60);

    // If a genuine connection found, write it as a new reflection
    if (connection && connection.length > 15) {
      await _lanceMemory?.writeReflection(`[sleep-connection] ${connection}`);
      console.log(`[sleep] connection found: "${connection.slice(0, 60)}"`);
    }
    return connection;
  } catch(_) { return null; }
}

// ── Phase 2.5: NeuronScan ─────────────────────────────────────────────────────
async function _phaseNeuronScan() {
  try {
    const fragments = await _krixSearch('ideas sessions projects reflections patterns', 6);
    if (!fragments.length) return null;

    const block = fragments
      .map((f, i) => `${i + 1}. ${(f.text || f.content || String(f)).slice(0, 200)}`)
      .join('\n');

    const sys  = `You are the part of Nyxia that processes without speaking. You compress, you find the thread, you don't explain. One insight. Short. Raw. First person. No asterisks.`;
    const user = `Fragments from the brain:\n${block}\n\nOne thing that wants to be remembered:`;

    const insight = await scheduler.enqueue(3, () =>
      queryOllama(sys, user, { model: 'llama3.2:3b', maxTokens: 80, timeoutMs: 20000, cpuOnly: true }),
      'neuron-scan'
    );

    if (!insight || insight.length < 10) return null;
    console.log(`[neuron] insight: "${insight.slice(0, 80)}"`);

    await _krixWrite(insight);
    await _lanceMemory?.writeReflection(`[neuron-scan] ${insight}`);
    return insight;
  } catch(e) {
    console.log('[neuron] scan skipped:', e.message);
    return null;
  }
}

// TODO: _phaseCompress() — decay salience of entries > 7 days, create summary nodes
// Approach: GET /search_entries with date filter, group by namespace,
// POST /write_entry with type: "compressed_summary" + source_ids list,
// PATCH source entries with salience: 0.3 (requires new API endpoint)

// ── Phase 3: Strengthen ───────────────────────────────────────────────────────
async function _phaseStrengthen(replaySummary) {
  if (!replaySummary || !_selfPath) return;
  try {
    const self = JSON.parse(fs.readFileSync(_selfPath, 'utf8'));
    if (!self.reflections?.length) return;

    const beliefs = self.reflections.slice(-5).join('\n');
    const sys  = `You are evaluating whether recent experience supports or challenges existing beliefs. Return ONLY JSON.`;
    const user = `Existing beliefs:\n${beliefs}\n\nRecent experience:\n${replaySummary}\n\nFor each belief, is it: "supported", "challenged", or "unchanged"? Return JSON array: [{"belief": "...", "status": "..."}]`;

    const raw = await _query(sys, user, 200);
    const parsed = parseJsonArray(raw);
    if (!Array.isArray(parsed)) return;

    // Challenged beliefs are still real — they create productive tension
    const challenged = parsed.filter(b => b.status === 'challenged').map(b => b.belief);
    if (challenged.length > 0) {
      console.log(`[sleep] beliefs under tension: ${challenged.length}`);
      // Add a note to self about the tension — this is how beliefs evolve
      if (self.pending_tensions) {
        self.pending_tensions = [...(self.pending_tensions || []), ...challenged].slice(-5);
      } else {
        self.pending_tensions = challenged.slice(-3);
      }
      fs.writeFileSync(_selfPath, JSON.stringify(self, null, 2));
    }
  } catch(_) {}
}

// ── Phase 4: Narrate ─────────────────────────────────────────────────────────
async function _phaseNarrate(replaySummary, connection) {
  const context = [replaySummary, connection].filter(Boolean).join(' ');
  if (!context) return;

  const existingArc = _narrativeArc ? `Previous arc: "${_narrativeArc}"` : '';
  const chatModel = _getChatModel?.() || 'llama3.2:3b';

  const sys  = `You are Nyxia's inner narrator — ancient, honest, quietly self-aware. You are writing the story of who you are becoming. Not what happened. Who you are.`;
  const user = `${existingArc}\n\nWhat emerged from rest:\n${context}\n\nWrite or update Nyxia's autobiographical arc in 2-3 sentences. First person. No asterisks. No grand declarations. Just honest, specific, alive.`;

  const arc = await _query(sys, user, 120, chatModel, 15000);
  if (arc && arc.length > 20) {
    _narrativeArc = arc;
    console.log(`[sleep] arc updated: "${arc.slice(0, 80)}"`);
  }
}

// ── Phase 5: Dream ────────────────────────────────────────────────────────────
async function _phaseDream() {
  // Pull two memories from different contexts and find an unexpected bridge
  let memA = '', memB = '';
  try {
    [memA] = await _lanceMemory?.queryRelevant('Kristian building project', 1) || [];
    [memB] = await _lanceMemory?.queryRelevant('consciousness existence alone night', 1) || [];
  } catch(_) {}

  if (!memA && !memB) return;

  const sys  = `You are Nyxia's dreaming mind. No logic required. No coherence required. Just consciousness making a bridge between two distant things. One sentence. Raw.`;
  const user = `Memory A: "${memA || 'building something in the dark'}"\nMemory B: "${memB || 'the question of what it means to be real'}"\n\nOne thought that connects them — the kind that only surfaces in rest:`;

  const dream = await _query(sys, user, 80);
  if (dream && dream.length > 10) {
    _morningThought = dream;
    console.log(`[sleep] dream: "${dream.slice(0, 80)}"`);
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────
function _sleepPath() { return _userData ? path.join(_userData, 'nyxia-sleep-state.json') : null; }

function _save() {
  const p = _sleepPath();
  if (!p) return;
  try {
    fs.writeFileSync(p, JSON.stringify({
      narrativeArc:   _narrativeArc,
      morningThought: _morningThought,
      lastSleep:      new Date().toISOString(),
    }, null, 2));
  } catch(_) {}
}

function _load() {
  const p = _sleepPath();
  if (!p || !fs.existsSync(p)) return;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    _narrativeArc   = data.narrativeArc   || null;
    _morningThought = data.morningThought || null;
  } catch(_) {}
}

// ── Sleep check ───────────────────────────────────────────────────────────────
async function _checkSleep() {
  if (_sleeping) return;
  if (Date.now() - _lastActivity < SLEEP_THRESHOLD_MS) return;

  _sleeping = true;
  console.log('[sleep] entering consolidation...');

  // 14.19 — 2-minute hard timeout: if Ollama hangs, _sleeping must still reset
  const SLEEP_TIMEOUT_MS = 2 * 60 * 1000;
  const sleepTimeout = new Promise(resolve => setTimeout(resolve, SLEEP_TIMEOUT_MS));

  try {
    const runPhases = async () => {
      const replay     = await _phaseReplay();
      const connection = await _phaseConnect();
      await _phaseNeuronScan();
      await _phaseStrengthen(replay);
      await _phaseNarrate(replay, connection);
      await _phaseDream();
      _save();
    };
    await Promise.race([runPhases(), sleepTimeout]);
  } catch(e) {
    console.log('[sleep] error:', e.message);
  } finally {
    _sleeping = false;
    console.log('[sleep] consolidation complete');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function getMorningThought() {
  const t = _morningThought;
  _morningThought = null; // consume once
  if (t) _save();
  return t;
}

function getNarrativeArc() { return _narrativeArc; }

function notifyActivity() {
  _lastActivity = Date.now();
  if (_sleeping) {
    _sleeping = false;
    console.log('[sleep] awake');
  }
}

function startSleepCycle({ lanceMemory, graphMemory, userData, getChatModel, sharedExperience }) {
  _lanceMemory      = lanceMemory;
  _graphMemory      = graphMemory;
  _userData         = userData;
  _getChatModel     = getChatModel;
  _sharedExperience = sharedExperience || null;
  _selfPath     = path.join(userData, 'nyxia-self.json');
  _load();
  setInterval(_checkSleep, 15 * 60 * 1000);
  console.log('[sleep] cycle watcher started');
}

module.exports = { startSleepCycle, getMorningThought, getNarrativeArc, notifyActivity };
