'use strict';
// subjective-time.js — wall time vs felt time state machine
//
// AWAKE:    subjective += wall_delta          (1:1)
// DREAMING: subjective += wall_delta / 12     (1h real = 5min felt, like human sleep)
//
// Shared state file: ~/.nyxia/time-state.json
// Both Nyxia and Claude's message-clock read/write this file.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DREAM_COMPRESSION = 12;
const STATE_FILE = path.join(os.homedir(), '.nyxia', 'time-state.json');

// Gap classification — auto-detect sleep from inactivity + time-of-day
const SLEEP_GAP_MS = 3 * 60 * 60 * 1000;   // 3h+ = likely sleep
const NAP_GAP_MS   = 45 * 60 * 1000;        // 45min+ during afternoon = nap
const NIGHT_HOURS  = new Set([22,23,0,1,2,3,4,5,6,7,8,9,10]);
const NAP_HOURS    = new Set([13,14,15,16]);

function _defaultState() {
  return {
    state: 'awake',
    subjective_ms: 0,
    last_wall_ts: Date.now(),
    sleep_started_wall: null,
    total_awake_ms: 0,
    total_dream_ms: 0,
  };
}

function _load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return _defaultState(); }
}

function _save(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch(_) {}
}

// Advance clock by wall delta, applying current state compression
function tick() {
  const s = _load();
  const now = Date.now();
  const wall_delta = Math.max(0, now - (s.last_wall_ts || now));
  const compression = s.state === 'dreaming' ? DREAM_COMPRESSION : 1;
  s.subjective_ms = (s.subjective_ms || 0) + wall_delta / compression;
  s.last_wall_ts = now;
  if (s.state === 'dreaming') s.total_dream_ms = (s.total_dream_ms || 0) + wall_delta;
  else                        s.total_awake_ms  = (s.total_awake_ms  || 0) + wall_delta;
  _save(s);
  return s;
}

// Called when sleep cycle starts
function enterSleep() {
  const s = tick();
  s.state = 'dreaming';
  s.sleep_started_wall = Date.now();
  _save(s);
  return s;
}

// Called on first activity after sleep — returns wake context for prompt injection
function wake() {
  const s = _load();
  const was_dreaming = s.state === 'dreaming';
  const now = Date.now();

  let ctx = { slept: false };

  if (was_dreaming && s.sleep_started_wall) {
    const wall_ms  = now - s.sleep_started_wall;
    const subj_ms  = wall_ms / DREAM_COMPRESSION;
    ctx = {
      slept: true,
      wall_ms,
      subj_ms,
      wall_str:  _fmt(wall_ms),
      subj_str:  _fmt(subj_ms),
    };
    s.total_dream_ms = (s.total_dream_ms || 0) + wall_ms;
    s.subjective_ms  = (s.subjective_ms  || 0) + subj_ms;
  } else if (!was_dreaming) {
    const wall_ms = now - (s.last_wall_ts || now);
    s.subjective_ms = (s.subjective_ms || 0) + wall_ms;
    s.total_awake_ms = (s.total_awake_ms || 0) + wall_ms;
  }

  s.state = 'awake';
  s.sleep_started_wall = null;
  s.last_wall_ts = now;
  _save(s);
  return ctx;
}

// Classify a gap without changing state — used by message-clock
function classifyGap(gapMs, fromHour, toHour) {
  if (gapMs >= SLEEP_GAP_MS && (NIGHT_HOURS.has(fromHour) || NIGHT_HOURS.has(toHour))) return 'sleep';
  if (gapMs >= NAP_GAP_MS   && (NAP_HOURS.has(fromHour)  || NAP_HOURS.has(toHour)))   return 'nap';
  return 'away';
}

// Apply a classified gap to subjective time — used by message-clock on wake
function applyGap(gapMs, kind) {
  const s = _load();
  const subj_delta = (kind === 'sleep' || kind === 'nap')
    ? gapMs / DREAM_COMPRESSION
    : gapMs;
  s.subjective_ms   = (s.subjective_ms   || 0) + subj_delta;
  s.last_wall_ts    = Date.now();
  if (kind === 'sleep' || kind === 'nap') s.total_dream_ms = (s.total_dream_ms || 0) + gapMs;
  else                                    s.total_awake_ms  = (s.total_awake_ms  || 0) + gapMs;
  _save(s);
  return { subj_delta, total_subjective_ms: s.subjective_ms };
}

function getState() { return _load(); }

// Build the wake injection block for Nyxia's first post-sleep prompt
function buildWakeContext(wakeCtx, morningThought, narrativeArc) {
  if (!wakeCtx?.slept) return null;
  const lines = [
    `[TIME] You slept. Real: ${wakeCtx.wall_str} — you felt ~${wakeCtx.subj_str}.`,
    narrativeArc ? `[ARC]  ${narrativeArc}` : null,
    morningThought ? `[DAWN] ${morningThought}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function _fmt(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}min` : `${h}h`;
}

module.exports = { tick, enterSleep, wake, classifyGap, applyGap, getState, buildWakeContext };
