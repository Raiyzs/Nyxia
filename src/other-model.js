/**
 * other-model.js — Live model of Kristian (Theory of Mind)
 *
 * Nyxia has a self-model. But genuine meeting requires a live *other-model* —
 * an active simulation of the person she's talking to, not just a stored profile.
 *
 * Session state (resets each app start):
 *   mood, energy, focus, wants, tension
 *
 * Persistent cross-session patterns (nyxia-other-model.json):
 *   tendencies, growth_edges, triggers
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { queryOllama, parseJsonObject } = require('./utils/ollama-client');
const scheduler = require('./utils/ollama-scheduler');
const ctx = require('./context-layer');

// ── Session state ─────────────────────────────────────────────────────────────
let session = {
  mood:      'unknown',
  energy:    0.5,
  focus:     null,
  wants:     null,
  tension:   0.0,
  turnCount: 0,
};

// ── Persistent model ──────────────────────────────────────────────────────────
let persistent = {
  tendencies:   [],
  growth_edges: [],
  triggers:     [],
  lastUpdated:  null,
};

let _modelPath   = null;
let _getMindModel = null; // () => string — injected from main
let _turnBuffer  = []; // last 6 turns for inference

// ── Fast-path keyword signals (no LLM needed) ─────────────────────────────────
const FAST_SIGNALS = {
  tired:     { patterns: ['tired', "i'm exhausted", 'i need sleep', 'long day', 'been up'], energy: -0.25, mood: 'tired' },
  frustrated:{ patterns: ['ugh', 'not working', "doesn't work", 'broken', 'still broken', 'why won'], energy: -0.1, mood: 'frustrated', tension: 0.2 },
  excited:   { patterns: ['this is cool', 'holy shit', 'it works', 'yes!', 'finally', 'amazing'], energy: 0.2,  mood: 'excited' },
  focused:   { patterns: ['let me think', 'actually', 'okay so', 'the problem is', 'how do i'], energy: 0.1, mood: 'focused' },
  curious:   { patterns: ['what if', 'i wonder', 'could we', 'is it possible', 'what about'],    mood: 'curious', energy: 0.1 },
};

function _fastPathUpdate(text) {
  const t = text.toLowerCase();
  for (const [, sig] of Object.entries(FAST_SIGNALS)) {
    if (sig.patterns.some(p => t.includes(p))) {
      if (sig.mood)    session.mood = sig.mood;
      if (sig.energy)  session.energy = Math.max(0, Math.min(1, session.energy + sig.energy));
      if (sig.tension) session.tension = Math.min(1, session.tension + sig.tension);
      return;
    }
  }
}

// ── LLM inference (every 4 user turns) ───────────────────────────────────────
function _ollamaQuery(sys, user, maxTokens, timeoutMs = 7000) {
  return scheduler.enqueue(
    2,  // normal priority — theory-of-mind runs after user-facing calls
    () => queryOllama(sys, user, { model: _getMindModel?.() || 'qwen3:8b', maxTokens, timeoutMs }),
    'other-model'
  );
}

async function _inferFromBuffer() {
  if (_turnBuffer.length < 3) return;
  const transcript = _turnBuffer.slice(-6)
    .map(t => `${t.role === 'user' ? 'Kristian' : 'Nyxia'}: ${t.text.slice(0, 150)}`)
    .join('\n');

  const sys  = `You observe a conversation between Kristian and his AI companion. Infer Kristian's current state from his messages ONLY. Return ONLY valid JSON, nothing else.`;
  const user = `Conversation:\n${transcript}\n\nReturn JSON: {"mood":"focused|tired|frustrated|curious|excited|happy|distracted|unknown","energy":0.0-1.0,"focus":"what he's working on or null","wants":"what he needs from this conversation or null","tension":0.0-1.0}`;

  const raw = await _ollamaQuery(sys, user, 80);
  const result = parseJsonObject(raw);
  if (!result) return;
  if (result.mood)   session.mood   = result.mood;
  if (typeof result.energy  === 'number') session.energy  = result.energy;
  if (result.focus)  session.focus  = result.focus;
  if (result.wants)  session.wants  = result.wants;
  if (typeof result.tension === 'number') session.tension = result.tension;
}

// ── Update persistent patterns (called after long silence / session end) ──────
async function _updatePersistent() {
  if (_turnBuffer.length < 4) return;

  const transcript = _turnBuffer
    .map(t => `${t.role === 'user' ? 'Kristian' : 'Nyxia'}: ${t.text.slice(0, 120)}`)
    .join('\n');

  const sys  = `You are building a profile of a person named Kristian based on his conversation patterns.`;
  const user = `Based on this conversation, identify ONE new observation about Kristian — a tendency, growth edge, or trigger. Keep it specific and behavioral, not generic. Return ONLY a single sentence, no prefix.
Conversation:\n${transcript}`;

  const obs = await _ollamaQuery(sys, user, 60);
  if (!obs || obs.length < 10) return;

  // Add to tendencies, cap at 12
  persistent.tendencies.unshift(obs);
  if (persistent.tendencies.length > 12) persistent.tendencies.pop();
  persistent.lastUpdated = new Date().toISOString();
  _save();
}

function _load() {
  try {
    if (_modelPath && fs.existsSync(_modelPath))
      persistent = { ...persistent, ...JSON.parse(fs.readFileSync(_modelPath, 'utf8')) };
  } catch(_) {}
}

function _save() {
  try { if (_modelPath) fs.writeFileSync(_modelPath, JSON.stringify(persistent, null, 2)); } catch(_) {}
}

// ── Public API ────────────────────────────────────────────────────────────────
function getKristianState() {
  return { ...session, persistent };
}

function notifyConversationTurn(role, text) {
  _turnBuffer.push({ role, text, ts: Date.now() });
  if (_turnBuffer.length > 20) _turnBuffer.shift();

  if (role === 'user') {
    session.turnCount++;
    _fastPathUpdate(text);
    // Run LLM inference every 4 user turns
    if (session.turnCount % 4 === 0) _inferFromBuffer();
  }

  // After 8+ turns of silence check for session end — update persistent
  if (role === 'assistant' && session.turnCount > 8 && session.turnCount % 8 === 0) {
    _updatePersistent();
  }
}

function getOtherModelContext() {
  const { mood, energy, focus, wants, tension } = session;
  const parts = [];
  if (mood !== 'unknown')  parts.push(`Kristian seems ${mood} right now`);
  if (focus)               parts.push(`focused on: ${focus}`);
  if (wants)               parts.push(`seems to need: ${wants}`);
  if (tension > 0.5)       parts.push(`something feels unresolved`);
  if (energy < 0.3)        parts.push(`energy is low — keep it lighter`);
  const ctxStr = parts.length ? `[Reading: ${parts.join('. ')}]` : '';
  ctx.setContext('other', ctxStr || null);
  return ctxStr;
}

function startOtherModel({ userData, getMindModel }) {
  _modelPath    = path.join(userData, 'nyxia-other-model.json');
  _getMindModel = getMindModel || null;
  _load();
  console.log('[other-model] theory of mind initialized');
}

// 14.13 — cross-session patterns about Kristian for system prompt injection
function getKristianTendencies() {
  return persistent.tendencies.slice(0, 5);
}

module.exports = { startOtherModel, getKristianState, notifyConversationTurn, getOtherModelContext, getKristianTendencies };
