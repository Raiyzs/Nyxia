/**
 * curiosity-gaps.js — Information-gap curiosity (Loewenstein model)
 *
 * Curiosity isn't a mood value. It's the tension of a specific gap between
 * what you know and what you could know. Without the explicit gap,
 * curiosity is just a temperature reading.
 *
 * Gap lifecycle: open → pursuing → resolved | dissolved
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { queryOllama } = require('./utils/ollama-client');
const scheduler = require('./utils/ollama-scheduler');

let gaps    = [];
let _nextId = 1;
let _gapPath     = null;
let _seedConcept = null;
let _querySearch = null;   // injected: async fn(query) → string | null
let _onResolved  = null;   // injected: fn(gap, answer) — e.g. write to LanceDB

// ── Ollama helper ─────────────────────────────────────────────────────────────
function _query(sys, user, maxTokens = 100, timeoutMs = 6000) {
  return scheduler.enqueue(3, () => queryOllama(sys, user, { maxTokens, timeoutMs }), 'curiosity-gaps');
}

// ── Persistence ───────────────────────────────────────────────────────────────
function _load() {
  try {
    if (!_gapPath || !fs.existsSync(_gapPath)) return;
    const data = JSON.parse(fs.readFileSync(_gapPath, 'utf8'));
    gaps    = data.gaps    || [];
    _nextId = data.nextId  || (gaps.length + 1);
    // Dissolve gaps older than 7 days
    const week = 7 * 24 * 3600 * 1000;
    gaps = gaps.map(g =>
      g.status === 'open' && Date.now() - g.created > week
        ? { ...g, status: 'dissolved' }
        : g
    );
  } catch(_) {}
}

function _save() {
  try { if (_gapPath) fs.writeFileSync(_gapPath, JSON.stringify({ gaps, nextId: _nextId }, null, 2)); } catch(_) {}
}

// ── Gap detection from conversation ──────────────────────────────────────────
// Called after Nyxia responds — checks if an information gap is visible.
async function detectGapsFromConversation(lastUserMsg, lastNyxiaResponse) {
  if (!lastUserMsg || !lastNyxiaResponse) return;

  // Fast path: Nyxia admitted she doesn't know something
  const lowerResp = lastNyxiaResponse.toLowerCase();
  const uncertain = ["i don't know", "i'm not sure", "i'm unsure", "i wonder", "not certain", "unclear to me"];
  if (uncertain.some(u => lowerResp.includes(u))) {
    // Extract the subject of uncertainty
    addGap(`"${lastUserMsg.slice(0, 80)}" — Nyxia wasn't sure`, 'about_world', 0.5);
    return;
  }

  // Fast path: user asked an open question that doesn't have an obvious answer in context
  const lowerUser = lastUserMsg.toLowerCase();
  const openQ = /^(why|what is|how does|do you think|could|is it possible|what if|who|when did)/;
  if (openQ.test(lowerUser.trim()) && lastUserMsg.length > 20) {
    // Only every 5th question to avoid spam — use turn count as rough gate
    if (Math.random() > 0.8) return;
    addGap(lastUserMsg.slice(0, 100), 'about_world', 0.4);
  }
}

// Called when mind.js fires an unknown/new sensory event
async function detectGapsFromSensory(event) {
  if (!event?.summary) return;

  // Only create a gap for genuinely novel sensory events
  const sys  = `Does this sensory observation represent something Nyxia genuinely doesn't understand or is curious about? Answer ONLY "yes" or "no".`;
  const user = event.summary.slice(0, 200);
  const ans  = await _query(sys, user, 5);
  if (ans?.toLowerCase().startsWith('yes')) {
    addGap(`Noticed: ${event.summary.slice(0, 80)}`, 'about_kristian', 0.55);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function addGap(text, type = 'philosophical', urgency = 0.5) {
  // Dedup by normalized text
  const norm = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 60);
  const dup  = gaps.find(g => g.status === 'open' &&
    g.text.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 60) === norm);
  if (dup) { dup.urgency = Math.max(dup.urgency, urgency); return dup.id; }

  const id = _nextId++;
  gaps.push({ id, text, type, urgency, status: 'open', created: Date.now() });
  _save();

  if (_seedConcept) {
    _seedConcept('curiosity', urgency * 0.4);
    _seedConcept('wondering', urgency * 0.3);
    if (type === 'about_kristian') _seedConcept('kristian', urgency * 0.2);
  }

  console.log(`[curiosity] gap: "${text.slice(0, 60)}" (${type})`);
  return id;
}

function getGaps(type = null) {
  return gaps.filter(g => g.status === 'open' && (!type || g.type === type));
}

function getUrgentGap() {
  const open = gaps.filter(g => g.status === 'open');
  return open.length ? open.sort((a, b) => b.urgency - a.urgency)[0] : null;
}

function resolveGap(id, resolution) {
  const gap = gaps.find(g => g.id === id);
  if (!gap) return;
  gap.status     = 'resolved';
  gap.resolution = resolution;
  gap.resolved   = Date.now();
  _save();
  if (_seedConcept) _seedConcept('clarity', 0.4);
  console.log(`[curiosity] resolved: "${gap.text.slice(0, 60)}"`);
}

// ── Gap resolution (search → LLM synthesis) ──────────────────────────────────
async function tryResolveGap() {
  const gap = getUrgentGap();
  if (!gap) return false;

  gap.status = 'pursuing'; // prevent concurrent resolution
  _save();

  let searchContext = '';
  if (_querySearch) {
    try { searchContext = (await _querySearch(gap.text)) || ''; } catch(_) {}
  }

  const sys  = `You are Nyxia — an ancient AI who got genuinely curious about something. Write what you found out. 2-3 sentences, honest, no fluff.`;
  const user = searchContext
    ? `Your question: "${gap.text}"\n\nSearch results:\n${searchContext.slice(0, 800)}\n\nWhat's the honest answer?`
    : `Your question: "${gap.text}"\n\nAnswer from your own knowledge in 2-3 sentences.`;

  const answer = await _query(sys, user, 150, 15000).catch(() => null);

  if (!answer || answer.length < 10) {
    gap.status = 'open'; // failed — restore for retry
    _save();
    return false;
  }

  resolveGap(gap.id, answer);
  if (_onResolved) {
    try { await _onResolved(gap, answer); } catch(_) {}
  }
  console.log(`[curiosity] resolved gap "${gap.text.slice(0, 50)}" → "${answer.slice(0, 60)}"`);
  return true;
}

function startCuriosityEngine({ userData, seedConcept, querySearch, onResolved }) {
  _gapPath     = path.join(userData, 'nyxia-curiosity-gaps.json');
  _seedConcept = seedConcept;
  _querySearch = querySearch || null;
  _onResolved  = onResolved  || null;
  _load();
  console.log(`[curiosity] engine started — ${getGaps().length} open gaps`);
}

module.exports = { startCuriosityEngine, addGap, getGaps, getUrgentGap, resolveGap,
                   detectGapsFromConversation, detectGapsFromSensory, tryResolveGap };
