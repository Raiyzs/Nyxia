'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const logger = require('./utils/logger');

// ── Chroma vector DB ──────────────────────────────────────────────────────────
const CHROMA_BIN  = '/var/data/python/bin/chroma';
const CHROMA_PORT = 8769;
let chromaProc = null;

async function ensureChroma(getUserData) {
  try {
    const res = await fetch(`http://127.0.0.1:${CHROMA_PORT}/api/v2/heartbeat`);
    if (res.ok) { logger.info('chroma', 'already running'); return; }
  } catch(_) {}

  if (!fs.existsSync(CHROMA_BIN)) {
    logger.warn('chroma', `binary not found at ${CHROMA_BIN}`);
    return;
  }

  const chromaPath = require('path').join(getUserData(), 'brain-chroma');
  logger.info('chroma', 'starting...');
  chromaProc = spawn(CHROMA_BIN, ['run', '--path', chromaPath, '--port', String(CHROMA_PORT), '--host', '127.0.0.1'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: process.env.HOME ? `${process.env.HOME}/.tmp` : '/tmp' },
  });
  chromaProc.stdout.on('data', d => logger.info('chroma', d.toString().trim()));
  chromaProc.stderr.on('data', d => logger.info('chroma', d.toString().trim()));
  chromaProc.on('error', e => logger.error('chroma', `spawn error: ${e.message}`));
  chromaProc.on('exit',  c => { logger.info('chroma', `exited: ${c}`); chromaProc = null; });

  // Wait up to 15s for it to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${CHROMA_PORT}/api/v2/heartbeat`);
      if (r.ok) { logger.info('chroma', 'ready'); return; }
    } catch(_) {}
  }
  logger.warn('chroma', 'did not respond within 15s — brain sectors will queue writes');
}

// ── Ollama ─────────────────────────────────────────────────────────────────────
const OLLAMA_BIN = '/usr/local/bin/ollama';
let ollamaProc = null;

// Deliberately hardcoded to localhost throughout — this function's job is
// "is a LOCAL Ollama already up, spawn one if not," a genuinely separate
// concern from where Nyxia's client actually sends its queries
// (config/ollama-endpoint.js). See the NAS-migration spark on this file.
async function ensureOllama() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/version');
    if (res.ok) { logger.info('ollama', 'already running'); return; }
  } catch (_) {}

  if (!fs.existsSync(OLLAMA_BIN)) {
    logger.warn('ollama', `binary not found at ${OLLAMA_BIN}`);
    return;
  }

  logger.info('ollama', 'starting...');
  ollamaProc = spawn(OLLAMA_BIN, ['serve'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME:          process.env.HOME || '/var/home/kvoldnes',
      OLLAMA_HOST:   '127.0.0.1:11434',
      OLLAMA_MODELS: `${process.env.HOME || '/var/home/kvoldnes'}/.ollama/models`,
      // RX 9070 XT: flash attention + q8 KV cache halve KV VRAM — keeps
      // nyxia-ft (14B Q4_K_M @ 8k ctx) at 100% GPU with headroom for vision swaps
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_KV_CACHE_TYPE:   'q8_0',
    },
  });
  ollamaProc.stdout.on('data', d => logger.info('ollama', d.toString().trim()));
  ollamaProc.stderr.on('data', d => logger.info('ollama', d.toString().trim()));
  ollamaProc.on('error', (e) => logger.error('ollama', `spawn error: ${e.message}`));
  ollamaProc.on('exit',  (c) => { logger.info('ollama', `exited: ${c}`); ollamaProc = null; });

  // Wait up to 8s for it to be ready
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch('http://127.0.0.1:11434/api/version');
      if (r.ok) { logger.info('ollama', 'ready'); return; }
    } catch (_) {}
  }
  logger.warn('ollama', 'did not respond within 8s');
}

/**
 * waitForVram(minMb, timeoutMs) — poll until at least minMb VRAM is free.
 * Returns true if enough VRAM became available, false if timed out.
 */
async function waitForVram(minMb = 5500, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { execSync } = require('child_process');
      const out = execSync('nvidia-smi --query-gpu=memory.free --format=csv,noheader 2>/dev/null', { timeout: 2000 }).toString().trim();
      const freeMb = parseInt(out);
      if (!isNaN(freeMb) && freeMb >= minMb) {
        logger.info('vram', `${freeMb}MB free — OK`);
        return true;
      }
      logger.info('vram', `waiting for VRAM — ${freeMb}MB free, need ${minMb}MB`);
    } catch(_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  logger.warn('vram', `timeout — never reached ${minMb}MB free`);
  return false;
}

// ── Reflex layer (Nengo SNN soul state server) ────────────────────────────────
const REFLEX_PORT = 8788;
const REFLEX_BIN  = '/var/home/kvoldnes/nyxia/backend/reflex_server.py';
let reflexProc = null;

async function ensureReflex() {
  try {
    const res = await fetch(`http://127.0.0.1:${REFLEX_PORT}/health`);
    if (res.ok) { logger.info('reflex', 'already running'); return; }
  } catch(_) {}

  if (!fs.existsSync(REFLEX_BIN)) {
    logger.warn('reflex', `not found: ${REFLEX_BIN}`);
    return;
  }

  logger.info('reflex', 'starting...');
  reflexProc = spawn('/usr/bin/python3', [REFLEX_BIN], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  reflexProc.stdout.on('data', d => logger.info('reflex', d.toString().trim()));
  reflexProc.stderr.on('data', d => logger.info('reflex', d.toString().trim()));
  reflexProc.on('error', e => logger.error('reflex', `spawn error: ${e.message}`));
  reflexProc.on('exit',  c => { logger.info('reflex', `exited: ${c}`); reflexProc = null; });
  // Non-blocking — reflex layer is optional, Nyxia works without it
}

// ── Cleanup helpers ───────────────────────────────────────────────────────────
function killChroma()      { if (chromaProc)  { chromaProc.kill();  chromaProc  = null; } }
function killOllama()      { if (ollamaProc)  { ollamaProc.kill();  ollamaProc  = null; } }
function killReflex()      { if (reflexProc)  { reflexProc.kill();  reflexProc  = null; } }
function isOllamaSpawned() { return !!ollamaProc; }

module.exports = { ensureChroma, ensureOllama, ensureReflex, waitForVram, killChroma, killOllama, killReflex, isOllamaSpawned };
