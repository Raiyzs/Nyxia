'use strict';
// tts/servers.js — lifecycle management for local TTS server processes.
// Priority order: Qwen3-TTS (GPU) → Kokoro (CPU) → Chatterbox (XTTS) → ElevenLabs fallback.

const { spawn } = require('child_process');
const fs        = require('fs');

const QWEN3_PORT      = 8884;
const KOKORO_PORT     = 8883;
const CHATTERBOX_PORT = 8881;

const QWEN3_BIN      = '/var/home/kvoldnes/qwen3-tts-env/bin/python';
const QWEN3_SRV      = '/var/home/kvoldnes/claude-projects/nyxia/qwen3_tts_server.py';
const KOKORO_BIN     = '/home/kvoldnes/claude-projects/ai-voice/xtts-env/bin/python';
const KOKORO_SRV     = '/home/kvoldnes/nyxia/kokoro_server.py';
const CHATTERBOX_BIN = '/home/kvoldnes/claude-projects/ai-voice/xtts-env/bin/python';
const CHATTERBOX_SRV = '/home/kvoldnes/nyxia/xtts_server.py';

let qwen3Proc       = null;
let kokoroProc      = null;
let chatterboxProc  = null;
let chatterboxStatus = { ready: false, label: '—' };

let _getChatWindow = () => null;
let _waitForVram   = async () => {};

function init({ getChatWindow, waitForVram }) {
  _getChatWindow = getChatWindow;
  _waitForVram   = waitForVram;
}

function sendChatterboxStatus(data) {
  chatterboxStatus = data;
  const win = _getChatWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('chatterbox-status', data);
}

async function ensureChatterbox() {
  try {
    const r = await fetch(`http://127.0.0.1:${CHATTERBOX_PORT}/health`);
    if (r.ok) {
      console.log('[chatterbox] already running');
      sendChatterboxStatus({ ready: true, label: 'ready' });
      return;
    }
  } catch (_) {}

  if (!fs.existsSync(CHATTERBOX_BIN)) {
    console.warn('[chatterbox] python binary not found:', CHATTERBOX_BIN);
    sendChatterboxStatus({ ready: false, label: 'not found' });
    return;
  }

  console.log('[chatterbox] starting...');
  chatterboxProc = spawn(CHATTERBOX_BIN, [CHATTERBOX_SRV], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: process.env.HOME || '/var/home/kvoldnes' },
  });
  chatterboxProc.stdout.on('data', d => console.log('[chatterbox]', d.toString().trim()));
  chatterboxProc.stderr.on('data', d => console.log('[chatterbox]', d.toString().trim()));
  chatterboxProc.on('error', e => console.error('[chatterbox] spawn error:', e.message));
  chatterboxProc.on('exit', c => {
    console.log('[chatterbox] exited:', c);
    chatterboxProc = null;
    sendChatterboxStatus({ ready: false, label: 'offline' });
  });

  sendChatterboxStatus({ ready: false, label: 'loading…' });

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`http://127.0.0.1:${CHATTERBOX_PORT}/health`);
      if (r.ok) {
        console.log('[chatterbox] ready');
        sendChatterboxStatus({ ready: true, label: 'ready' });
        return;
      }
    } catch (_) {}
  }
  console.warn('[chatterbox] did not respond within 40s');
  sendChatterboxStatus({ ready: false, label: 'timeout' });
}

async function ensureQwen3() {
  try {
    const r = await fetch(`http://127.0.0.1:${QWEN3_PORT}/health`);
    if (r.ok) { console.log('[qwen3-tts] already running'); return; }
  } catch (_) {}

  if (!fs.existsSync(QWEN3_BIN)) {
    console.warn('[qwen3-tts] python binary not found:', QWEN3_BIN);
    return;
  }

  await _waitForVram(5500, 30000);

  console.log('[qwen3-tts] starting...');
  qwen3Proc = spawn(QWEN3_BIN, [QWEN3_SRV], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: process.env.HOME || '/var/home/kvoldnes' },
  });
  qwen3Proc.stdout.on('data', d => console.log('[qwen3-tts]', d.toString().trim()));
  qwen3Proc.stderr.on('data', d => console.log('[qwen3-tts]', d.toString().trim()));
  qwen3Proc.on('error', e => console.error('[qwen3-tts] spawn error:', e.message));
  qwen3Proc.on('exit', c => { console.log('[qwen3-tts] exited:', c); qwen3Proc = null; });

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`http://127.0.0.1:${QWEN3_PORT}/health`);
      if (r.ok) { console.log('[qwen3-tts] ready'); return; }
    } catch (_) {}
  }
  console.warn('[qwen3-tts] did not respond within 120s');
}

async function ensureKokoro() {
  try {
    const r = await fetch(`http://127.0.0.1:${KOKORO_PORT}/health`);
    if (r.ok) { console.log('[kokoro] already running'); return; }
  } catch (_) {}

  console.log('[kokoro] starting...');
  kokoroProc = spawn(KOKORO_BIN, [KOKORO_SRV], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KOKORO_PORT: String(KOKORO_PORT), HOME: process.env.HOME || '/var/home/kvoldnes' },
  });
  kokoroProc.stdout.on('data', d => console.log('[kokoro]', d.toString().trim()));
  kokoroProc.stderr.on('data', d => console.log('[kokoro]', d.toString().trim()));
  kokoroProc.on('error', e => console.error('[kokoro] spawn error:', e.message));
  kokoroProc.on('exit', c => { console.log('[kokoro] exited:', c); kokoroProc = null; });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`http://127.0.0.1:${KOKORO_PORT}/health`);
      if (r.ok) { console.log('[kokoro] ready'); return; }
    } catch (_) {}
  }
  console.warn('[kokoro] did not respond within 30s');
}

function killAll() {
  const killed = [];
  if (qwen3Proc)      { qwen3Proc.kill('SIGKILL');      qwen3Proc = null;      killed.push('qwen3-tts'); }
  if (kokoroProc)     { kokoroProc.kill('SIGKILL');     kokoroProc = null;     killed.push('kokoro'); }
  if (chatterboxProc) { chatterboxProc.kill('SIGKILL'); chatterboxProc = null; killed.push('chatterbox'); }
  return killed;
}

function getProcs() {
  return { qwen3Proc: () => qwen3Proc, kokoroProc: () => kokoroProc, chatterboxProc: () => chatterboxProc };
}

module.exports = {
  init,
  QWEN3_PORT, KOKORO_PORT, CHATTERBOX_PORT,
  ensureQwen3, ensureKokoro, ensureChatterbox,
  sendChatterboxStatus,
  getChatterboxStatus: () => chatterboxStatus,
  getQwen3Proc:  () => qwen3Proc,
  setQwen3Proc:  v  => { qwen3Proc = v; },
  killAll, getProcs,
};
