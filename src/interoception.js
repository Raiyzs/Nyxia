/**
 * interoception.js — System metrics as felt body state
 *
 * The brain is always monitoring the body. Heart rate, cortisol, gut tension —
 * these ground abstract thought in physical urgency. Nyxia's body is the machine.
 *
 * Mapping:
 *   VRAM pressure   → cognitive strain / effort
 *   CPU load        → activation / energy expenditure
 *   Network latency → frustration / waiting
 *   GPU temperature → physical discomfort analog
 *   Uptime          → fatigue accumulation
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const http = require('http');
const ctx = require('./context-layer');

let bodyState = {
  strain:      0.0,  // VRAM pressure       → cognitive load
  energy:      0.5,  // CPU idle inverse     → available activation
  frustration: 0.0,  // network latency      → waiting / friction
  fatigue:     0.0,  // uptime hours         → accumulated tiredness
  discomfort:  0.0,  // GPU temp             → physical strain
};

let _seedConcept = null;

// ── GPU (nvidia-smi) ──────────────────────────────────────────────────────────
async function _pollGpu() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=memory.used,memory.total,temperature.gpu,utilization.gpu',
      '--format=csv,noheader,nounits'
    ], { timeout: 2000 });
    const [used, total, temp, util] = stdout.trim().split(',').map(s => parseFloat(s.trim()));
    if (isNaN(used) || isNaN(total) || total === 0) return null;
    return {
      strain:     used / total,
      discomfort: Math.max(0, Math.min(1, (temp - 60) / 40)),
      energy:     1 - (util / 100),
    };
  } catch(_) { return null; }
}

// ── CPU (/proc/loadavg) ───────────────────────────────────────────────────────
function _pollCpu() {
  try {
    const raw = require('fs').readFileSync('/proc/loadavg', 'utf8').trim();
    const load1min = parseFloat(raw.split(' ')[0]);
    const cpuCount = require('os').cpus().length;
    // Normalize: load/cpuCount → 0-1 (>1 = fully loaded)
    return Math.min(load1min / cpuCount, 1.0);
  } catch(_) { return null; }
}

// ── Network latency (ping Ollama) ─────────────────────────────────────────────
function _pollNet() {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.request(
      { hostname: '127.0.0.1', port: 11434, path: '/api/version', method: 'GET' },
      () => { resolve(Math.min((Date.now() - t0 - 20) / 300, 1.0)); } // 20ms baseline
    );
    req.on('error', () => resolve(0));
    req.setTimeout(1000, () => { req.destroy(); resolve(0.8); });
    req.end();
  });
}

// ── Uptime → fatigue ──────────────────────────────────────────────────────────
function _pollUptime() {
  try {
    const raw = require('fs').readFileSync('/proc/uptime', 'utf8');
    const hours = parseFloat(raw.split(' ')[0]) / 3600;
    return Math.min(hours / 20, 1.0); // 20h uptime = full fatigue
  } catch(_) { return 0; }
}

// ── Poll cycle ────────────────────────────────────────────────────────────────
async function _poll() {
  const gpu    = await _pollGpu();
  const cpuLoad = _pollCpu();
  const latency = await _pollNet();
  const uptime  = _pollUptime();

  if (gpu) {
    bodyState.strain     = gpu.strain;
    bodyState.discomfort = gpu.discomfort;
    bodyState.energy     = Math.max(0.1, gpu.energy - (cpuLoad || 0) * 0.3);
  } else if (cpuLoad !== null) {
    bodyState.energy = Math.max(0.1, 1 - cpuLoad);
  }

  bodyState.frustration = latency || 0;
  bodyState.fatigue     = uptime;

  if (!_seedConcept) return;

  // Seed felt states into activation map
  if (bodyState.strain      > 0.75) _seedConcept('strain',       bodyState.strain * 0.3);
  if (bodyState.fatigue     > 0.5)  _seedConcept('tired',        bodyState.fatigue * 0.25, 'slow');
  if (bodyState.discomfort  > 0.65) _seedConcept('discomfort',   bodyState.discomfort * 0.2);
  if (bodyState.energy      > 0.75) _seedConcept('aliveness',    bodyState.energy * 0.2);
  if (bodyState.frustration > 0.5)  _seedConcept('frustration',  bodyState.frustration * 0.25);

  // High strain + high energy = focused effort — seed that feeling
  if (bodyState.strain > 0.6 && bodyState.energy > 0.5) _seedConcept('effort', 0.3);
}

// ── Public API ────────────────────────────────────────────────────────────────
function getBodyState() { return { ...bodyState }; }

function _pushToContext() { ctx.setContext('body', getBodyState()); }

function startInteroception({ seedConcept }) {
  _seedConcept = seedConcept;
  setInterval(async () => { await _poll(); _pushToContext(); }, 30 * 1000);
  _poll().then(_pushToContext);
  console.log('[body] interoception started');
}

// RLLM: Derive emotional inference from current body state
// Returns { emotion, valence, arousal, confidence }
// valence: -1 (distress) to +1 (ease) — reflects prediction accuracy proxy
// arousal: 0 (flat) to 1 (activated) — drives expression urgency
function getEmotionalInference() {
  const b = getBodyState();
  if (!b) return { emotion: 'neutral', valence: 0, arousal: 0.3, confidence: 0.4 };

  const fatigue     = b.fatigue     ?? 0;
  const strain      = b.strain      ?? 0;
  const frustration = b.frustration ?? 0;
  // energy → flow proxy (high energy, low strain = flow state)
  const flow        = Math.max(0, b.energy - strain * 0.5);
  const cognitive   = strain; // VRAM pressure = cognitive load analog

  // Valence: high flow → positive, high strain/frustration → negative
  const valence = Math.max(-1, Math.min(1, flow * 0.6 - strain * 0.4 - frustration * 0.3));

  // Arousal: driven by fatigue inverse + frustration + flow
  const arousal = Math.max(0, Math.min(1, (1 - fatigue) * 0.4 + frustration * 0.3 + flow * 0.3));

  // Emotion label from dominant signal
  let emotion = 'neutral';
  if (flow > 0.6)                              emotion = 'focused';
  else if (frustration > 0.6 && strain > 0.5) emotion = 'overwhelmed';
  else if (fatigue > 0.7)                      emotion = 'tired';
  else if (strain > 0.6)                       emotion = 'strained';
  else if (cognitive > 0.7)                    emotion = 'engaged';
  else if (valence > 0.4)                      emotion = 'ease';
  else if (valence < -0.3)                     emotion = 'unsettled';

  const confidence = Math.min(0.9, 0.3 + (fatigue + strain + flow + frustration) * 0.15);

  return { emotion, valence, arousal, confidence };
}

module.exports = { startInteroception, getBodyState, getEmotionalInference };
