'use strict';
// causal-model.js — Lightweight causal belief graph (RLLM world model layer)
// Tracks cause→effect patterns observed in Kristian's work/mood/behavior.
// Each edge has a confidence score that updates with each new observation.
// Exposes getCausalExplanation() for prompt-builder injection.

const fs   = require('fs');
const path = require('path');

let _causalPath = null;
let _edges      = [];   // [{ id, cause, effect, confidence, observations, lastUpdated }]
let _userData   = null;

const CONFIDENCE_GAIN = 0.12;  // per confirming observation
const CONFIDENCE_DECAY = 0.04; // per disconfirming observation
const MIN_CONFIDENCE   = 0.1;
const MAX_CONFIDENCE   = 0.95;

function _save() {
  try { if (_causalPath) fs.writeFileSync(_causalPath, JSON.stringify({ edges: _edges }, null, 2)); } catch(_) {}
}

function _load() {
  try {
    if (_causalPath && fs.existsSync(_causalPath)) {
      const d = JSON.parse(fs.readFileSync(_causalPath, 'utf8'));
      _edges = d.edges || [];
    }
  } catch(_) {}
}

// Add or reinforce a causal belief
function inferCausalRelation(cause, effect, confirmed = true) {
  cause  = cause.toLowerCase().trim().slice(0, 80);
  effect = effect.toLowerCase().trim().slice(0, 80);
  if (!cause || !effect) return;

  let edge = _edges.find(e => e.cause === cause && e.effect === effect);
  if (!edge) {
    edge = { id: Date.now(), cause, effect, confidence: 0.3, observations: 0, lastUpdated: Date.now() };
    _edges.push(edge);
    console.log(`[causal] new edge: "${cause}" → "${effect}"`);
  }

  edge.observations++;
  edge.lastUpdated = Date.now();
  if (confirmed) {
    edge.confidence = Math.min(MAX_CONFIDENCE, edge.confidence + CONFIDENCE_GAIN);
  } else {
    edge.confidence = Math.max(MIN_CONFIDENCE, edge.confidence - CONFIDENCE_DECAY);
  }

  // Prune low-confidence old edges (< 0.15, > 30 days old)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  _edges = _edges.filter(e => e.confidence > 0.15 || e.lastUpdated > cutoff);

  _save();
  return edge;
}

// Get edges related to a concept (as cause or effect)
function getRelatedEdges(concept, limit = 5) {
  const lower = concept.toLowerCase();
  return _edges
    .filter(e => e.cause.includes(lower) || e.effect.includes(lower))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

// Get top confident causal beliefs for injection into system prompt
function getCausalExplanation(limit = 4) {
  const top = _edges
    .filter(e => e.confidence > 0.45 && e.observations >= 2)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
  if (!top.length) return '';
  return '[Causal patterns I\'ve observed]\n' +
    top.map(e => `• "${e.cause}" → "${e.effect}" (confidence: ${(e.confidence * 100).toFixed(0)}%)`).join('\n');
}

// Seed initial plausible edges from common patterns (low confidence — needs observation)
function _seedDefaults() {
  if (_edges.length > 0) return; // don't overwrite existing learned edges
  const seeds = [
    ['context switching',     'cognitive fatigue increase',   0.3],
    ['long focus session',    'productivity peak then drop',  0.3],
    ['late night coding',     'next-day energy lower',        0.25],
    ['documentation reading', 'motivation increase',          0.25],
    ['debugging loop > 1hr',  'frustration signal',           0.3],
    ['new project discussion', 'excitement spike',            0.25],
  ];
  for (const [cause, effect, confidence] of seeds) {
    _edges.push({ id: Date.now() + Math.random(), cause, effect, confidence, observations: 0, lastUpdated: Date.now() });
  }
  _save();
}

function getEdges() { return [..._edges]; }

function start({ userData }) {
  _userData   = userData;
  _causalPath = path.join(userData, 'nyxia-causal-model.json');
  _load();
  _seedDefaults();
  console.log(`[causal] started — ${_edges.length} causal edges loaded`);
}

module.exports = { start, inferCausalRelation, getRelatedEdges, getCausalExplanation, getEdges };
