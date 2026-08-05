'use strict';
// nyxia-vessel — always-on CPU/RAM background daemon
// Runs independently of Electron. No GPU, no inference.
// Accumulates signals, queues observations for when Electron reconnects.
// Port 7424. Electron pings on start, drains queue on wake.

const http     = require('http');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');
const { execFile } = require('child_process');

const PORT       = 7424;
const STATE_FILE = path.join(os.homedir(), '.config/Nyxia/vessel_state.json');
const LOG_FILE   = path.join(os.homedir(), '.config/Nyxia/vessel.log');
const QUEUE_MAX  = 100;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  lastElectronPing: 0,
  absenceMs: 0,
  clipboard: '',
  clipboardChanges: 0,
  systemSamples: [],
  observationQueue: [],
};

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...saved, observationQueue: saved.observationQueue || [] };
    if (state.lastElectronPing > 0)
      state.absenceMs = Date.now() - state.lastElectronPing;
    log(`state loaded — absence so far: ${Math.round(state.absenceMs / 60000)}min`);
  } catch {
    log('no saved state, starting fresh');
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`save failed: ${e.message}`);
  }
}

function enqueue(observation) {
  state.observationQueue.push({ ts: Date.now(), ...observation });
  if (state.observationQueue.length > QUEUE_MAX)
    state.observationQueue.shift();
}

// ── Sensors ───────────────────────────────────────────────────────────────────

// Screen lock — poll GetActive via dbus-send every 30s
// GetSessionIdleTime unsupported on Wayland; GetActive (screen locked) is reliable.
let _screenLockedSince = 0;
function _pollScreenLock() {
  execFile('dbus-send', [
    '--session', '--print-reply',
    '--dest=org.freedesktop.ScreenSaver',
    '/ScreenSaver',
    'org.freedesktop.ScreenSaver.GetActive',
  ], { timeout: 3000 }, (err, stdout) => {
    if (err) return;
    const locked = stdout.includes('boolean true');
    if (locked && !_screenLockedSince) {
      _screenLockedSince = Date.now();
      log('screen locked');
    } else if (!locked && _screenLockedSince) {
      const lockedMins = Math.round((Date.now() - _screenLockedSince) / 60_000);
      _screenLockedSince = 0;
      if (lockedMins > 0) {
        enqueue({ type: 'screen_unlock', summary: `Screen was locked for ${lockedMins} minute${lockedMins !== 1 ? 's' : ''}`, lockedMins });
        log(`screen unlocked after ${lockedMins}min`);
      }
    }
  });
}
setInterval(_pollScreenLock, 30_000);
_pollScreenLock();

// System load — every 30s
setInterval(() => {
  const [l1, l5] = os.loadavg();
  const freeMB   = Math.round(os.freemem() / 1024 / 1024);
  const totalMB  = Math.round(os.totalmem() / 1024 / 1024);
  const usedPct  = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  const sample   = { ts: Date.now(), load1: +l1.toFixed(2), load5: +l5.toFixed(2), freeMB, usedPct };

  state.systemSamples.push(sample);
  if (state.systemSamples.length > 120) state.systemSamples.shift(); // keep 1hr

  if (l1 > 6.0) {
    enqueue({ type: 'high_load', summary: `CPU load spiked to ${l1.toFixed(1)} — something is working hard` });
    log(`high load: ${l1.toFixed(1)}`);
  }
  if (usedPct > 88) {
    enqueue({ type: 'high_ram', summary: `RAM at ${usedPct}% — only ${freeMB}MB free` });
  }
}, 30_000);

// Clipboard — poll every 20s via wl-paste (Wayland)
let _clipPrev = '';
setInterval(() => {
  execFile('wl-paste', ['--no-newline'], { timeout: 3000 }, (err, stdout) => {
    if (err || !stdout || stdout.length < 4) return;
    const text = stdout.slice(0, 600).trim();
    if (text === _clipPrev) return;
    _clipPrev = text;
    state.clipboard = text;
    state.clipboardChanges++;
    enqueue({ type: 'clipboard', summary: text.slice(0, 140) });
    log(`clipboard change #${state.clipboardChanges}: ${text.slice(0, 60)}`);
  });
}, 20_000);

// Absence tracking — every 60s, save every 5min
let _saveCounter = 0;
setInterval(() => {
  if (state.lastElectronPing === 0) return;
  state.absenceMs = Date.now() - state.lastElectronPing;
  const mins = Math.round(state.absenceMs / 60_000);

  // Queue once per hour after first 30min
  if (mins >= 30 && mins % 60 < 2) {
    enqueue({ type: 'absence', summary: `${mins} minutes since last session`, absenceMs: state.absenceMs });
    log(`absence observation queued: ${mins}min`);
  }

  if (++_saveCounter % 5 === 0) saveState();
}, 60_000);

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/vessel/state') {
    res.end(JSON.stringify({
      absenceMs: state.absenceMs,
      absenceMins: Math.round(state.absenceMs / 60_000),
      lastElectronPing: state.lastElectronPing,
      systemLoad: state.systemSamples.slice(-6),
      clipboardChanges: state.clipboardChanges,
      queueLength: state.observationQueue.length,
      uptime: Math.round(process.uptime()),
    }));

  } else if (req.method === 'GET' && req.url === '/vessel/queue') {
    // Drain and return the observation queue
    const queue = [...state.observationQueue];
    state.observationQueue = [];
    saveState();
    res.end(JSON.stringify(queue));

  } else if (req.method === 'POST' && req.url === '/vessel/ping') {
    // Electron announces it's alive — record absence before resetting
    const prevAbsenceMs = state.lastElectronPing > 0
      ? Date.now() - state.lastElectronPing
      : 0;
    const wasAbsent = prevAbsenceMs > 5 * 60_000;

    state.lastElectronPing = Date.now();
    state.absenceMs = 0;
    saveState();

    log(`electron ping — was absent: ${wasAbsent} (${Math.round(prevAbsenceMs / 60000)}min)`);
    res.end(JSON.stringify({ ok: true, wasAbsent, prevAbsenceMs }));

  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
loadState();
server.listen(PORT, '127.0.0.1', () => {
  log(`vessel running on 127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT',  () => { saveState(); process.exit(0); });
