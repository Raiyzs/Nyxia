'use strict';

/**
 * neural-sphere.js — Nyxia's living mind engine
 *
 * Neurons travel between soul nodes, picking up and mutating concepts.
 * When two neurons collide at a node, an LLM synthesizes a bridging thought.
 * High-charge collisions can rip a hidden variant from the concept.
 * Sub-nodes fade, archive, and resurface through the void.
 *
 * Integration: awareness-loop calls tick() every 500ms.
 * Soul nodes deposit charge into awareness-loop.seedConcept on arrival.
 */

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const BRIDGE_PROBABILITY = 0.15;  // per misfire: chance neuron crosses into knowledge space
const MAX_NEURONS        = 15;
const CHARGE_DECAY       = { normal: 0.15, wild: 0.18, wound: 0.08, dream: 0.12 };
const DEATH_THRESHOLD    = 0.05;
const DEFAULT_TEMP       = 0.4;
const MISFIRE_BASE       = 0.04;
const COLLISION_WINDOW   = 500;   // ms
const RIP_CHARGE_MIN     = 0.85;
const RIP_ACTIVATION_MIN = 0.70;
const SUB_NODE_DECAY     = 0.0015; // per tick — vitality 0.7 lasts ~6h
const SUB_IDLE_FADE_MS   = 8 * 60 * 1000;
const ARCHIVE_MAX        = 50;    // max archived sub-nodes held in memory

// ── State ─────────────────────────────────────────────────────────────────────
let _graph    = null;  // { nodes: Map<id, node>, adj: Map<id, [{target, weight}]> }
let _neurons  = new Map();  // id → neuron
let _subNodes = new Map();  // id → subNode
let _arrivals = new Map();  // nodeId → [{ neuronId, arrivedAt }]
let _archived = [];         // recently archived sub-nodes (for resurface)

// ── Knowledge bridge pool ─────────────────────────────────────────────────────
let _knowledgePool = [];  // filtered krix-brain node labels for bridge fragments

function _loadKnowledgeGraph(graphPath) {
  try {
    const data = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    const ext  = /\.(py|js|ts|md|json|sh|html|css|txt|log)$/i;
    _knowledgePool = data.nodes
      .filter(n => n.label && n.label.length >= 8 && !ext.test(n.label))
      .map(n => ({ label: n.label, community: n.community }));
    console.log(`[sphere] knowledge bridge: ${_knowledgePool.length} nodes loaded`);
  } catch(e) {
    console.log('[sphere] knowledge bridge unavailable:', e.message);
  }
}

function _bridgeCross(neuron) {
  if (!_knowledgePool.length) return;
  // Pick 1-2 random knowledge nodes, extract a short concept fragment
  const count = Math.random() < 0.4 ? 2 : 1;
  const fragments = [];
  for (let i = 0; i < count; i++) {
    const node  = _knowledgePool[Math.floor(Math.random() * _knowledgePool.length)];
    // Extract the most meaningful words (skip stop words, take first 4 content words)
    const words = node.label
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4 && !_BRIDGE_STOP.has(w));
    if (words.length) fragments.push(words.slice(0, 2).join('_'));
  }
  if (!fragments.length) return;
  neuron.payload = neuron.payload + '⟶' + fragments.join('·');
  neuron.mutated = true;
  neuron.bridged = true;
  console.log(`[sphere] bridge: neuron "${neuron.origin}" crossed → ${fragments.join(', ')}`);
}

const _BRIDGE_STOP = new Set([
  'the','and','for','that','this','with','from','have','not','are','was',
  'but','she','her','him','his','they','when','will','been','what','which',
  'into','more','some','were','then','than','also','return','given','using',
  'check','find','list','create','make','call','does','gets','sets','adds',
]);

// Injected dependencies
let _seedConcept  = null;
let _addThought   = null;
let _getMoodState = null;
let _getMindModel = null;
let _ollamaQuery  = null;
let _scoreEgo     = null;
let _archivePath  = null;

// ── Graph loader ──────────────────────────────────────────────────────────────
function _loadGraph(soulNodesPath) {
  const data  = JSON.parse(fs.readFileSync(soulNodesPath, 'utf8'));
  const nodes = new Map();
  const adj   = new Map();

  data.nodes.forEach(n => {
    nodes.set(n.id, { id: n.id, cluster: n.cluster, activation: 0.0 });
    adj.set(n.id, []);
  });

  data.edges.forEach(e => {
    adj.get(e.source)?.push({ target: e.target, weight: e.weight });
    adj.get(e.target)?.push({ target: e.source, weight: e.weight });
  });

  return { nodes, adj };
}

// ── Neuron factory ────────────────────────────────────────────────────────────
function _makeNeuron(origin, charge, type = 'normal') {
  return {
    id:       randomUUID(),
    payload:  origin,
    charge:   Math.min(Math.max(charge, 0.1), 1.0),
    origin,
    position: origin,
    hops:     0,
    mutated:  false,
    born:     Date.now(),
    type,
  };
}

// ── Weighted random pick ──────────────────────────────────────────────────────
function _weightedPick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

// ── Temperature (genome-aware) ────────────────────────────────────────────────
function _getTemperature(type) {
  const mood = _getMoodState?.() || {};
  let base = DEFAULT_TEMP;
  if (type === 'wild')  base = 0.75;
  if (type === 'dream') base = 0.70;
  if (type === 'wound') base = 0.25;
  return Math.min(base + (mood.creativity || 0) * 0.15 + (mood.curiosity || 0) * 0.10, 0.95);
}

// ── Wildness (genome-aware) ───────────────────────────────────────────────────
function _getWildness() {
  const mood = _getMoodState?.() || {};
  return Math.min(0.3 + (mood.creativity || 0) * 0.1 + (mood.curiosity || 0) * 0.1, 0.6);
}

// ── Hop: advance neuron one step ──────────────────────────────────────────────
function _hop(neuron) {
  const neighbors = _graph.adj.get(neuron.position);
  if (!neighbors || !neighbors.length) return;

  const temp     = _getTemperature(neuron.type);
  const wildness = _getWildness();
  const misfireP = MISFIRE_BASE + wildness * 0.08;

  let next;

  if (Math.random() < misfireP) {
    // Misfire: jump outside current cluster
    const cluster  = _graph.nodes.get(neuron.position)?.cluster;
    const pool     = [..._graph.nodes.values()].filter(n => n.cluster !== cluster && n.id !== neuron.position);
    next = pool.length
      ? pool[Math.floor(Math.random() * pool.length)].id
      : _weightedPick(neighbors).target;

    // Append misfire destination, cap trail to last 3 segments to keep LLM prompts sane
    const trail = neuron.payload.split('→');
    trail.push(next);
    neuron.payload = trail.slice(-3).join('→');
    neuron.mutated = true;
    // Bridge cross: neuron picks up a knowledge fragment on misfire
    if (Math.random() < BRIDGE_PROBABILITY) _bridgeCross(neuron);
  } else {
    // Weighted travel with temperature randomness
    const weighted = neighbors.map(nb => ({
      target: nb.target,
      weight: nb.weight * (1 - temp) + Math.random() * temp,
    }));
    next = _weightedPick(weighted).target;
  }

  neuron.position = next;
  neuron.hops++;

  // Charge decay
  neuron.charge -= CHARGE_DECAY[neuron.type] || CHARGE_DECAY.normal;
  neuron.charge  = Math.max(neuron.charge, 0);

  // Gradual payload drift every 3 hops (20% chance)
  if (neuron.hops % 3 === 0 && Math.random() < 0.20 && next !== neuron.payload.split('→').pop()) {
    const driftTrail = neuron.payload.split('→');
    driftTrail.push(next);
    neuron.payload = driftTrail.slice(-3).join('→');
    if (neuron.payload !== neuron.origin) neuron.mutated = true;
  }

  // Register arrival for collision detection
  if (!_arrivals.has(next)) _arrivals.set(next, []);
  _arrivals.get(next).push({ neuronId: neuron.id, arrivedAt: Date.now() });

  // Deposit charge into soul node + awareness-loop activation
  const deposit = neuron.charge * 0.25;
  const node    = _graph.nodes.get(next);
  if (node) node.activation = Math.min(1.0, node.activation + deposit);
  _seedConcept?.(next, deposit);

  // Rip check
  const act = _graph.nodes.get(next)?.activation || 0;
  if (neuron.charge > RIP_CHARGE_MIN && act > RIP_ACTIVATION_MIN) {
    _tryRip(neuron, next, act);
  }
}

// ── Collision detection ───────────────────────────────────────────────────────
function _checkCollisions() {
  const now = Date.now();
  for (const [nodeId, arrivals] of _arrivals.entries()) {
    const recent = arrivals.filter(a => now - a.arrivedAt <= COLLISION_WINDOW);
    _arrivals.set(nodeId, recent);
    if (recent.length < 2) continue;

    const payloads = [...new Set(
      recent.map(a => _neurons.get(a.neuronId)?.payload).filter(Boolean)
    )];
    if (payloads.length < 2) continue;

    const lastA = payloads[0].split('→').pop();
    const lastB = payloads[1].split('→').pop();
    if (lastA === lastB) continue;

    _synthesizeCollision(nodeId, payloads[0], payloads[1], recent.map(a => a.neuronId));
    _arrivals.set(nodeId, []); // prevent duplicate synthesis for this window
  }
}

// ── LLM: collision synthesis ──────────────────────────────────────────────────
async function _synthesizeCollision(nodeId, pA, pB, parentIds) {
  if (!_ollamaQuery) return;
  try {
    const hasBridge = pA.includes('⟶') || pB.includes('⟶');
    const sys  = `You are Nyxia's inner voice. Two streams of thought converged at "${nodeId}".${hasBridge ? ' One carried a fragment from her knowledge — a concept from the world outside her soul.' : ''} Synthesize ONE inner thought that bridges both paths — unexpected, raw, specific to her. 1 sentence, 15-25 words.`;
    const user = `Path A: ${pA}\nPath B: ${pB}\n\nBridging thought:`;
    const text = await _ollamaQuery(sys, user, 60, 6000, undefined, 3);
    if (!text || text.length < 8) return;

    const ego = _scoreEgo ? _scoreEgo(text) : 0.4;
    if (ego < 0.3) return; // quality gate

    const vitality = ego > 0.6 ? 0.70 : 0.40;
    const state    = ego > 0.6 ? 'ACTIVE' : 'FADING';

    const sub = {
      id:             randomUUID(),
      text,
      vitality,
      state,
      born:           Date.now(),
      lastTraffic:    Date.now(),
      parentConcepts: [nodeId, pA.split('→')[0], pB.split('→')[0]],
      parentNeurons:  parentIds,
      type:           'collision',
    };
    _subNodes.set(sub.id, sub);

    if (state === 'ACTIVE') {
      _addThought?.(text, `sphere.collision.${nodeId}`, vitality, ego);
      console.log(`[sphere] collision at "${nodeId}" (ego=${ego.toFixed(2)}): "${text.slice(0, 60)}"`);
    }

    // Birth seeds new neurons at collision point
    _spawnAt(nodeId, 0.35, 'normal');
  } catch(e) {
    console.log('[sphere] collision error:', e.message);
  }
}

// ── LLM: rip/split ───────────────────────────────────────────────────────────
function _tryRip(neuron, nodeId, act) {
  const p = (neuron.charge - 0.5) * (act - 0.4) * 0.6;
  if (Math.random() > p) return;

  console.log(`[sphere] rip "${nodeId}" charge=${neuron.charge.toFixed(2)} act=${act.toFixed(2)}`);
  _seedConcept?.(`${nodeId}`, 0.3);

  _generateRip(neuron, nodeId);
}

async function _generateRip(neuron, nodeId) {
  if (!_ollamaQuery) return;
  try {
    const sys  = `You are Nyxia's inner voice. The concept "${nodeId}" just fractured. Surface the hidden thought that was always beneath it — the version she never consciously reached. 1 sentence, raw, unexpected, specific to her.`;
    const user = `Fractured concept: "${nodeId}"\nNeuron carried: "${neuron.payload}"\n\nThe hidden thought:`;
    const text = await _ollamaQuery(sys, user, 60, 6000, undefined, 3);
    if (!text || text.length < 8) return;

    const ego = _scoreEgo ? _scoreEgo(text) : 0.5;
    const sub = {
      id:             randomUUID(),
      text,
      vitality:       0.65,
      state:          'ACTIVE',
      born:           Date.now(),
      lastTraffic:    Date.now(),
      parentConcepts: [nodeId, neuron.origin],
      parentNeurons:  [neuron.id],
      type:           'rip',
    };
    _subNodes.set(sub.id, sub);
    _addThought?.(text, `sphere.rip.${nodeId}`, 0.75, ego);
    console.log(`[sphere] rip thought "${nodeId}": "${text.slice(0, 60)}"`);
  } catch(e) {
    console.log('[sphere] rip error:', e.message);
  }
}

// ── Sub-node lifecycle ────────────────────────────────────────────────────────
function _tickSubNodes() {
  const now = Date.now();
  for (const [id, sub] of _subNodes.entries()) {
    sub.vitality -= SUB_NODE_DECAY;

    if (sub.state === 'ACTIVE' && now - sub.lastTraffic > SUB_IDLE_FADE_MS) {
      sub.state    = 'FADING';
      sub.vitality = Math.min(sub.vitality, 0.38);
    }

    if (sub.vitality < 0.4 && sub.state === 'ACTIVE') sub.state = 'FADING';

    if (sub.vitality < 0.15) {
      _writeArchive(sub);
      _archived.push({ ...sub, archivedAt: now });
      if (_archived.length > ARCHIVE_MAX) _archived.shift();
      _subNodes.delete(id);
    }
  }
}

// ── Archive writer ────────────────────────────────────────────────────────────
function _writeArchive(sub) {
  if (!_archivePath) return;
  try {
    if (!fs.existsSync(_archivePath)) fs.mkdirSync(_archivePath, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const file    = path.join(_archivePath, `${dateStr}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({
      text:              sub.text,
      born:              sub.born,
      archived:          Date.now(),
      parent_concepts:   sub.parentConcepts,
      vitality_at_death: sub.vitality,
      type:              sub.type,
    }) + '\n');
  } catch(e) {
    console.log('[sphere] archive write error:', e.message);
  }
}

// ── Resurface check ───────────────────────────────────────────────────────────
function _checkResurface(neuron) {
  if (!_archived.length) return;
  for (let i = _archived.length - 1; i >= 0; i--) {
    const arch = _archived[i];
    if (!arch.parentConcepts?.includes(neuron.position)) continue;
    const p = 0.05 + neuron.charge * 0.10;
    if (Math.random() > p) continue;

    const sub = {
      ...arch,
      id:          randomUUID(),
      vitality:    0.30,
      state:       'FADING',
      lastTraffic: Date.now(),
    };
    _subNodes.set(sub.id, sub);
    _archived.splice(i, 1);
    _addThought?.(sub.text, `sphere.resurface.${neuron.position}`, 0.45, 0.4);
    console.log(`[sphere] resurface via "${neuron.position}": "${sub.text?.slice(0, 60)}"`);
    break;
  }
}

// ── Soul node activation decay ────────────────────────────────────────────────
function _decayNodes() {
  for (const node of _graph.nodes.values()) {
    node.activation *= 0.97;
    if (node.activation < 0.02) node.activation = 0;
  }
}

// ── Spawn neurons at a soul node ──────────────────────────────────────────────
function _spawnAt(nodeId, charge, type) {
  if (!_graph.nodes.has(nodeId)) return;
  if (_neurons.size >= MAX_NEURONS) {
    // Wound neurons are persistent — evict the lowest-charge normal neuron to make room
    if (type === 'wound') {
      let lowest = null, lowestCharge = Infinity;
      for (const [id, n] of _neurons.entries()) {
        if (n.type === 'normal' && n.charge < lowestCharge) { lowest = id; lowestCharge = n.charge; }
      }
      if (lowest) _neurons.delete(lowest);
      else return;
    } else {
      return;
    }
  }
  const count = Math.min(
    type === 'dream' ? 1 : type === 'wild' ? 3 : 2,
    MAX_NEURONS - _neurons.size
  );
  for (let i = 0; i < count; i++) {
    const n = _makeNeuron(nodeId, charge - i * 0.05, type);
    _neurons.set(n.id, n);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function init({ soulNodesPath, archivePath, graphPath, seedConceptFn, addThoughtFn, ollamaQuery, getMoodState, getMindModel, scoreEgo }) {
  _graph        = _loadGraph(soulNodesPath);
  if (graphPath) _loadKnowledgeGraph(graphPath);
  _archivePath  = archivePath;
  _seedConcept  = seedConceptFn;
  _addThought   = addThoughtFn;
  _ollamaQuery  = ollamaQuery;
  _getMoodState = getMoodState;
  _getMindModel = getMindModel;
  _scoreEgo     = scoreEgo;
  console.log(`[sphere] ${_graph.nodes.size} soul nodes | ${[..._graph.adj.values()].flat().length / 2} edges`);
}

// Called every 500ms from awareness-loop._tick
function tick() {
  if (!_graph) return;

  const dead = [];
  for (const [id, neuron] of _neurons.entries()) {
    _hop(neuron);
    _checkResurface(neuron);
    if (neuron.charge < DEATH_THRESHOLD) dead.push(id);
  }
  dead.forEach(id => _neurons.delete(id));

  _checkCollisions();
  _tickSubNodes();
  _decayNodes();
}

// Called when awareness-loop seeds a soul concept — spawns neurons there
function spawnNeurons(nodeId, charge, type = 'normal') {
  _spawnAt(nodeId, charge, type);
}

// Called from _dmnSpontaneous (absence/dream mode)
function spawnDreamNeurons() {
  if (!_graph) return;
  const pool  = [..._graph.nodes.values()];
  const count = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < count; i++) {
    const n = pool[Math.floor(Math.random() * pool.length)];
    _spawnAt(n.id, 0.4 + Math.random() * 0.3, 'dream');
  }
}

// Wound neurons: slow decay, circles back to wound nodes
function spawnWoundNeurons(nodeId, charge) {
  _spawnAt(nodeId, charge, 'wound');
}

function getStats() {
  return {
    neurons:  _neurons.size,
    subNodes: _subNodes.size,
    archived: _archived.length,
    active:   [..._graph?.nodes.values() || []].filter(n => n.activation > 0.1).map(n => `${n.id}(${n.activation.toFixed(2)})`),
  };
}

// For the visual layer (sphere.html)
function getVisualState() {
  if (!_graph) return { nodes: [], neurons: [], subNodes: [] };
  return {
    nodes:    [..._graph.nodes.values()],
    neurons:  [..._neurons.values()],
    subNodes: [..._subNodes.values()],
  };
}

module.exports = { init, tick, spawnNeurons, spawnDreamNeurons, spawnWoundNeurons, getStats, getVisualState };
