'use strict';
// predicted-reality.js — Prediction-correction feedback loop (RLLM core)
// Nyxia predicts Kristian's state hourly, observes reality, updates beliefs when wrong.
// Prediction errors → CORRECTED edges in graph-memory, urgency-weighted curiosity gaps.
const fs   = require('fs');
const path = require('path');

let _graphMemory    = null;  // injected: { writeCorrection }
let _lanceMemory    = null;  // injected: { writeReflection }
let _getMoodState   = null;  // injected: () => moodState
let _getSensory     = null;  // injected: () => current sensory context string
let _addGap         = null;  // injected: addGap(text, type, urgency)
let _userData       = null;
let _predictions    = [];    // in-memory: { id, timestamp, fields: {focus,mood,topic,energy}, resolved }
let _confidenceScores = {};  // { focus: 0.7, mood: 0.6, ... } — rolling accuracy
let _predPath       = null;

const FIELDS = ['focus', 'mood', 'topic', 'energy'];

function _save() {
  try { if (_predPath) fs.writeFileSync(_predPath, JSON.stringify({ predictions: _predictions.slice(-50), confidenceScores: _confidenceScores }, null, 2)); } catch(_) {}
}

function _load() {
  try {
    if (_predPath && fs.existsSync(_predPath)) {
      const d = JSON.parse(fs.readFileSync(_predPath, 'utf8'));
      _predictions      = d.predictions      || [];
      _confidenceScores = d.confidenceScores || {};
    }
  } catch(_) {}
}

// Generate a prediction of Kristian's state for the next ~1 hour
// Uses current mood, sensory context, and historical pattern (simplified heuristic)
function predictNextState() {
  const mood    = _getMoodState?.() || {};
  const sensory = _getSensory?.()   || '';

  // Heuristic extraction from mood + sensory signals
  const focusVal   = mood.curiosity > 0.5 ? 'high' : mood.fatigue > 0.6 ? 'low' : 'medium';
  const moodVal    = mood.dominant  || 'neutral';
  const energyVal  = mood.fatigue  > 0.6 ? 'low' : mood.excitement > 0.5 ? 'high' : 'medium';
  const topicGuess = sensory.length > 20 ? sensory.split(/\s+/).slice(0, 3).join(' ') : 'unknown';

  const pred = {
    id:        Date.now(),
    timestamp: Date.now(),
    fields: { focus: focusVal, mood: moodVal, topic: topicGuess, energy: energyVal },
    resolved:  false,
  };
  _predictions.push(pred);
  _save();
  console.log(`[predicted-reality] prediction: focus=${focusVal}, mood=${moodVal}, energy=${energyVal}`);
  return pred;
}

// Compare a prediction against observed reality, update confidence scores and graph
async function recordOutcome(predId, observed = {}) {
  const pred = _predictions.find(p => p.id === predId && !p.resolved);
  if (!pred) return;
  pred.resolved  = true;
  pred.observed  = observed;
  pred.scoredAt  = Date.now();

  let errors = 0;
  let total  = 0;
  for (const field of FIELDS) {
    if (observed[field] === undefined) continue;
    total++;
    const correct = (pred.fields[field] === observed[field]);
    if (!correct) {
      errors++;
      // Write belief correction to graph-memory
      if (_graphMemory?.writeCorrection) {
        await _graphMemory.writeCorrection(
          `Predicted ${field}="${pred.fields[field]}"`,
          `Observed  ${field}="${observed[field]}"`
        ).catch(() => {});
      }
      // Add a curiosity gap — why was the model wrong?
      if (_addGap) {
        _addGap(
          `Prediction error: expected ${field}=${pred.fields[field]}, saw ${observed[field]}. Why?`,
          'about_kristian', 0.45
        );
      }
    }
    // Rolling confidence per field (EMA)
    const prev = _confidenceScores[field] ?? 0.5;
    _confidenceScores[field] = prev * 0.85 + (correct ? 1 : 0) * 0.15;
  }

  const accuracy = total > 0 ? (total - errors) / total : 1;
  pred.accuracy  = accuracy;

  // Write to LanceDB as a reflection
  if (_lanceMemory?.writeReflection && total > 0) {
    const note = `[prediction-outcome] accuracy=${(accuracy * 100).toFixed(0)}% over ${total} fields`;
    await _lanceMemory.writeReflection(note).catch(() => {});
  }

  _save();
  console.log(`[predicted-reality] outcome: accuracy=${(accuracy * 100).toFixed(0)}%, errors=${errors}/${total}`);
  return { accuracy, errors, total };
}

// Called periodically — tries to score the oldest unresolved prediction using current observations
async function tryScoreOldest() {
  const stale = _predictions.find(p => !p.resolved && Date.now() - p.timestamp > 45 * 60 * 1000);
  if (!stale) return;
  const mood    = _getMoodState?.() || {};
  const observed = {
    focus:  mood.curiosity > 0.5 ? 'high' : mood.fatigue > 0.6 ? 'low' : 'medium',
    mood:   mood.dominant  || 'neutral',
    energy: mood.fatigue   > 0.6 ? 'low' : mood.excitement > 0.5 ? 'high' : 'medium',
  };
  await recordOutcome(stale.id, observed);
}

function getConfidenceScores() { return { ..._confidenceScores }; }
function getLatestPrediction()  { return _predictions.filter(p => !p.resolved).slice(-1)[0] || null; }

function start({ graphMemory, lanceMemory, getMoodState, getSensory, addGap, userData }) {
  _graphMemory  = graphMemory;
  _lanceMemory  = lanceMemory;
  _getMoodState = getMoodState;
  _getSensory   = getSensory;
  _addGap       = addGap;
  _userData     = userData;
  _predPath     = path.join(userData, 'nyxia-predictions.json');
  _load();

  // Predict every hour
  setInterval(() => predictNextState(), 60 * 60 * 1000);
  // Score stale predictions every 30min
  setInterval(() => tryScoreOldest(), 30 * 60 * 1000);

  // First prediction after 2min (let app settle)
  setTimeout(() => predictNextState(), 2 * 60 * 1000);

  console.log(`[predicted-reality] started — ${_predictions.length} historical predictions loaded`);
}

module.exports = { start, predictNextState, recordOutcome, tryScoreOldest, getConfidenceScores, getLatestPrediction };
