'use strict';
// action-tracker.js — Logs Nyxia's suggestions and scores whether they landed.
// When Nyxia makes a suggestion, log it. After 30min, observe mood/engagement delta.
// Ineffective patterns → lower future confidence. Effective ones → reinforce.

const fs   = require('fs');
const path = require('path');

let _trackerPath  = null;
let _log          = [];      // [{ id, ts, text, type, scored, moodAtTime, moodAfter, effective }]
let _getMoodState = null;    // injected: () => moodState
let _graphMemory  = null;    // injected: { writeCorrection } for ineffective edge

const SCORE_AFTER_MS = 30 * 60 * 1000; // score 30min after suggestion

function _save() {
  try { if (_trackerPath) fs.writeFileSync(_trackerPath, JSON.stringify({ log: _log.slice(-100) }, null, 2)); } catch(_) {}
}

function _load() {
  try {
    if (_trackerPath && fs.existsSync(_trackerPath)) {
      const d = JSON.parse(fs.readFileSync(_trackerPath, 'utf8'));
      _log = d.log || [];
    }
  } catch(_) {}
}

// Detect suggestion type from text
function _detectType(text) {
  const lower = text.toLowerCase();
  if (/you should|try |consider |why not |have you tried|what if you|maybe you/.test(lower)) return 'suggestion';
  if (/i think|i believe|i suspect|in my view/.test(lower)) return 'opinion';
  if (/\?$/.test(text.trim())) return 'question';
  return null;
}

// Log a suggestion/opinion when Nyxia speaks
function logAction(text) {
  const type = _detectType(text);
  if (!type) return;

  const mood = _getMoodState?.() || {};
  const dominant = Object.entries(mood)
    .filter(([k]) => k !== 'heartbeat')
    .sort(([, a], [, b]) => b - a)[0]?.[0] || 'neutral';

  const entry = {
    id: Date.now(),
    ts: Date.now(),
    text: text.slice(0, 200),
    type,
    scored: false,
    moodAtTime: dominant,
    moodAfter: null,
    effective: null,
  };
  _log.push(entry);
  _save();
}

// Score unscored entries older than SCORE_AFTER_MS
async function scoreStale() {
  const now  = Date.now();
  const mood = _getMoodState?.() || {};
  const dominant = Object.entries(mood)
    .filter(([k]) => k !== 'heartbeat')
    .sort(([, a], [, b]) => b - a)[0]?.[0] || 'neutral';

  let changed = false;
  for (const entry of _log) {
    if (entry.scored || now - entry.ts < SCORE_AFTER_MS) continue;
    entry.moodAfter = dominant;
    // Heuristic: mood stayed same or improved = effective; worsened = ineffective
    const POSITIVE = ['happy', 'curious', 'excited', 'focused', 'playful'];
    const NEGATIVE  = ['sad', 'frustrated', 'concerned', 'bored'];
    const wasPos   = POSITIVE.includes(entry.moodAtTime);
    const isPos    = POSITIVE.includes(dominant);
    const wasNeg   = NEGATIVE.includes(entry.moodAtTime);
    const isNeg    = NEGATIVE.includes(dominant);
    entry.effective = (wasPos && isPos) || (!wasNeg && !isNeg) || (wasNeg && isPos);
    entry.scored    = true;
    changed = true;

    if (!entry.effective && entry.type === 'suggestion' && _graphMemory?.writeCorrection) {
      await _graphMemory.writeCorrection(
        `Suggestion: "${entry.text.slice(0, 80)}"`,
        `Appeared ineffective — mood did not improve (before: ${entry.moodAtTime}, after: ${dominant})`
      ).catch(() => {});
    }
    console.log(`[action-tracker] scored "${entry.text.slice(0, 50)}" → ${entry.effective ? 'effective' : 'ineffective'}`);
  }
  if (changed) _save();
}

// Rolling effectiveness rate for a given type
function getEffectivenessScore(type = 'suggestion') {
  const relevant = _log.filter(e => e.scored && e.type === type);
  if (!relevant.length) return 0.5; // unknown → assume neutral
  const effective = relevant.filter(e => e.effective).length;
  return effective / relevant.length;
}

function start({ userData, getMoodState, graphMemory }) {
  _getMoodState = getMoodState;
  _graphMemory  = graphMemory;
  _trackerPath  = path.join(userData, 'nyxia-action-tracker.json');
  _load();

  // Score stale entries every 35min
  setInterval(() => scoreStale(), 35 * 60 * 1000);

  console.log(`[action-tracker] started — ${_log.length} logged actions`);
}

module.exports = { start, logAction, scoreStale, getEffectivenessScore };
