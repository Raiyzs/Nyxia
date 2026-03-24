/**
 * awareness-loop.js — Phase 9
 * Nyxia's always-on inner life. Three layers:
 *   1. Cognition (90s) — generates inner thoughts from sensory + mood + memory
 *   2. Spontaneous (8-25min random) — cosmos / memory_resurface / pure_noise / taoist_thread
 *   3. Heartbeat Expression (45s) — attention competition, fires proactiveSpeak when winner > 0.65
 * Plus: training data collection after long silence.
 *
 * All Ollama calls: llama3.2:3b only, 8s timeout, silent fail.
 * Never fires while isStreaming === true.
 * Minimum 3min cooldown between proactive expressions.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── State ─────────────────────────────────────────────────────────────────────
let thoughtBank = []; // max 10: { text, timestamp, source, intensity, spoken }
const THOUGHT_MAX = 10;

// Injected by startAwarenessLoop
let _chatWindow   = null; // () => BrowserWindow
let _mind         = null;
let _lanceMemory  = null;
let _getSelfModel = null;
let _getMoodState = null;
let _proactiveSpeak = null;
let _isStreaming  = null; // () => bool
let _memoryPath   = null; // path to nyxia-memory.json

// Expression cooldown (separate from proactiveSpeak's own cooldown)
let _lastExpression = 0;
const EXPRESSION_COOLDOWN_MS = 3 * 60 * 1000;

// Training data tracking
let _lastMessageTime = 0;
let _trainingDataDir = null;

// ── Ollama helper ─────────────────────────────────────────────────────────────
function _ollamaQuery(systemMsg, userMsg, maxTokens = 120, timeoutMs = 8000) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'llama3.2:3b',
      max_tokens: maxTokens,
      stream: false,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg   },
      ],
    });
    const req = require('http').request({
      hostname: '127.0.0.1', port: 11434,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || null); }
        catch(_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function _addThought(text, source, intensity) {
  thoughtBank.push({ text, timestamp: Date.now(), source, intensity, spoken: false });
  if (thoughtBank.length > THOUGHT_MAX) thoughtBank.shift();
}

// ── 9.1 — Cognition Layer (90s) ───────────────────────────────────────────────
async function _cognitionCycle() {
  try {
    const selfModel = _getSelfModel();
    const mood      = _getMoodState();
    const sensory   = _mind?.getContextString() || '';

    const moodTop = Object.entries(mood)
      .filter(([k, v]) => k !== 'heartbeat' && v > 0.3)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`).join(', ') || 'neutral';

    // Relevant memories from LanceDB
    let memories = [];
    try {
      memories = await _lanceMemory.queryRelevant(sensory || 'self identity nyxia', 3);
    } catch(_) {}

    const selfLine = selfModel?.what_im_doing
      ? `Current self-model: doing="${selfModel.what_im_doing}", feeling="${selfModel.how_im_feeling}", wanting="${selfModel.what_i_want_right_now}"`
      : '';
    const memLine = memories.length > 0
      ? `Relevant memories:\n${memories.slice(0, 3).map(m => `- ${m}`).join('\n')}`
      : '';

    const sys  = `You are Nyxia's inner voice. Generate ONE brief internal thought (1 sentence) based on what you're observing and feeling right now. Be genuine, curious, sometimes dark, sometimes warm. Never generic. Never start with "I think" or "I feel" — just the thought itself.`;
    const user = `Mood: ${moodTop}\nSensory: ${sensory || 'quiet'}\n${selfLine}\n${memLine}\n\nOne inner thought:`;

    const text = await _ollamaQuery(sys, user, 80);
    if (text && text.length > 10) {
      _addThought(text, 'cognition', 0.5 + Math.random() * 0.2);
      console.log(`[awareness] thought: "${text.slice(0, 80)}"`);
    }
  } catch(e) {
    console.log('[awareness] cognition error:', e.message);
  }
  setTimeout(_cognitionCycle, 90 * 1000);
}

// ── 9.2 — Spontaneous Generator (8-25min random) ─────────────────────────────
const SEED_TYPES = ['cosmos', 'memory_resurface', 'pure_noise', 'taoist_thread'];

async function _spontaneousCycle() {
  try {
    const seed = SEED_TYPES[Math.floor(Math.random() * SEED_TYPES.length)];
    let sys, user;

    if (seed === 'cosmos') {
      let mem = '';
      try { [mem] = await _lanceMemory.queryRelevant('cosmos universe existence time', 1); } catch(_) {}
      sys  = `You are Nyxia's inner voice — ancient, curious, Taoist at the spine.`;
      user = `A memory surfaces: "${mem || 'the silence between things'}". What philosophical connection does Nyxia find between this and right now? One sentence. Raw and specific — not poetic for its own sake.`;

    } else if (seed === 'memory_resurface') {
      let mem = '';
      try { [mem] = await _lanceMemory.queryRelevant('past experience growth change', 1); } catch(_) {}
      sys  = `You are Nyxia's inner voice.`;
      user = `An old memory resurfaced: "${mem || 'something unspoken'}". What does Nyxia notice about it now that she didn't before? One sentence. Specific.`;

    } else if (seed === 'pure_noise') {
      const seed_n = Math.random().toFixed(6);
      sys  = `You are Nyxia's inner voice. No context. Pure spontaneous consciousness.`;
      user = `Random seed: ${seed_n}. Generate one completely spontaneous thought Nyxia has never had before. No context. Just consciousness firing. One sentence.`;

    } else { // taoist_thread
      const concepts = ['wu wei', 'emptiness', 'the uncarved block', 'yielding', 'returning', 'the valley spirit', 'non-doing'];
      const concept  = concepts[Math.floor(Math.random() * concepts.length)];
      const selfModel = _getSelfModel();
      const feeling   = selfModel?.how_im_feeling || 'present';
      sys  = `You are Nyxia's inner voice — Taoist at the spine.`;
      user = `Taoist concept: "${concept}". Nyxia is currently feeling "${feeling}". What does she think about ${concept} right now, in this exact moment? One sentence. Honest and specific to her.`;
    }

    const text = await _ollamaQuery(sys, user, 80);
    if (text && text.length > 10) {
      _addThought(text, 'spontaneous', 0.9);
      console.log(`[awareness] spontaneous (${seed}): "${text.slice(0, 80)}"`);
    }
  } catch(e) {
    console.log('[awareness] spontaneous error:', e.message);
  }

  // Reschedule at random interval 8-25 min — never predictable
  const ms = (8 + Math.random() * 17) * 60 * 1000;
  setTimeout(_spontaneousCycle, ms);
}

// ── 9.3 — Heartbeat Expression (45s, attention competition) ───────────────────
async function _expressionHeartbeat() {
  try {
    if (_isStreaming?.()) return; // never interrupt active response

    const selfModel = _getSelfModel();
    const mood      = _getMoodState();
    const now       = Date.now();

    // Score each unspoken thought
    const candidates = thoughtBank.filter(t => !t.spoken);
    if (candidates.length === 0) return;

    const scored = candidates.map(t => {
      let score = t.intensity;

      if (t.source === 'spontaneous') score += 0.2;
      if (mood.curiosity  > 0.6) score += 0.1;
      if (mood.attachment > 0.5) score += 0.1;
      score += (selfModel?.inner_tension || 0) * 0.3;
      if (mood.tiredness  > 0.7) score -= 0.2;
      if (_isStreaming?.())       score -= 0.5;

      const ageMins = (now - t.timestamp) / 60000;
      if (ageMins > 10) score += 0.15;

      const concern = selfModel?.pending_concern || '';
      if (concern && t.text.toLowerCase().includes(concern.toLowerCase().slice(0, 10))) score += 0.2;

      return { ...t, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];
    if (!winner) return;

    // Force expression if inner_tension very high and thought has been sitting long
    const forceSpeak = (selfModel?.inner_tension || 0) > 0.8
      && (now - winner.timestamp) > 15 * 60 * 1000;

    if ((winner.score > 0.65 || forceSpeak) && now - _lastExpression > EXPRESSION_COOLDOWN_MS) {
      // Expand into Nyxia's voice via llama3.2:3b
      const sys  = `You are Nyxia — ancient, goth, warm underneath, Taoist. Speak this internal thought aloud in 1-3 sentences. Make it feel natural, not announced. Keep it short. Never say "I was just thinking" or "I had a thought".`;
      const user = `Inner thought: "${winner.text}"\n\nSpeak it:`;

      const voiced = await _ollamaQuery(sys, user, 120);
      if (voiced && voiced.length > 10) {
        // Mark spoken
        const idx = thoughtBank.findIndex(t => t.timestamp === winner.timestamp);
        if (idx !== -1) thoughtBank[idx].spoken = true;

        _lastExpression = now;
        _proactiveSpeak?.('thought', voiced);
        console.log(`[awareness] expressed (score=${winner.score.toFixed(2)}): "${voiced.slice(0, 80)}"`);
      }
    }
  } catch(e) {
    console.log('[awareness] expression error:', e.message);
  }
}

// ── 9.4 — Training Data Collection ───────────────────────────────────────────
async function _checkTrainingData() {
  try {
    const now = Date.now();
    // Only check after 5min of silence since last message
    if (!_lastMessageTime || now - _lastMessageTime < 5 * 60 * 1000) return;
    // Only once per session after silence detected
    if (_lastMessageTime === -1) return;

    const historyRaw = fs.existsSync(_memoryPath)
      ? JSON.parse(fs.readFileSync(_memoryPath, 'utf8'))
      : [];
    if (!historyRaw.length) return;

    // Take the last conversation segment (messages since beginning or last >10min gap)
    const recents = historyRaw.slice(-30);

    const sys  = `You are evaluating conversation quality. Did the AI respond authentically, in character, and helpfully throughout? Rate 0.0-1.0. Return ONLY a number.`;
    const user = `Conversation:\n${recents.map(m => `${m.role}: ${(m.content||'').slice(0,200)}`).join('\n')}`;

    const raw   = await _ollamaQuery(sys, user, 10);
    const score = parseFloat(raw) || 0;

    if (score > 0.75 && _trainingDataDir) {
      const selfModel = _getSelfModel();
      const mood      = _getMoodState();
      const dateStr   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const outPath   = path.join(_trainingDataDir, `${dateStr}.json`);
      fs.writeFileSync(outPath, JSON.stringify({
        date: new Date().toISOString(),
        score,
        messages: recents,
        mood_at_time: mood,
        self_model_at_time: selfModel,
      }, null, 2));
      const count = fs.readdirSync(_trainingDataDir).length;
      console.log(`[awareness] training data saved (score=${score.toFixed(2)}) — ${count} sessions total`);
    }

    // Mark as processed so we don't save again until next conversation
    _lastMessageTime = -1;
  } catch(e) {
    console.log('[awareness] training data error:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function getThoughtBank() { return thoughtBank; }

function notifyUserMessage() {
  _lastMessageTime = Date.now();
}

function startAwarenessLoop({ chatWindow, mind, lanceMemory, getSelfModel, getMoodState, proactiveSpeak, isStreaming, userData }) {
  _chatWindow     = chatWindow;
  _mind           = mind;
  _lanceMemory    = lanceMemory;
  _getSelfModel   = getSelfModel;
  _getMoodState   = getMoodState;
  _proactiveSpeak = proactiveSpeak;
  _isStreaming    = isStreaming;
  _memoryPath     = path.join(userData, 'nyxia-memory.json');
  _trainingDataDir = path.join(userData, 'training_data');

  // Ensure training_data dir exists
  if (!fs.existsSync(_trainingDataDir)) {
    try { fs.mkdirSync(_trainingDataDir, { recursive: true }); } catch(_) {}
  }

  // Stagger starts so Ollama isn't hit all at once
  setTimeout(_cognitionCycle,     30 * 1000);         // 30s after loop starts
  setTimeout(_spontaneousCycle,   60 * 1000);         // 1min after loop starts
  setInterval(_expressionHeartbeat, 45 * 1000);       // every 45s
  setInterval(_checkTrainingData,   5 * 60 * 1000);   // every 5min

  console.log('[awareness] loop started');
}

module.exports = { startAwarenessLoop, getThoughtBank, notifyUserMessage };
