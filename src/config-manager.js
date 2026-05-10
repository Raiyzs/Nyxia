'use strict';

const fs   = require('fs');
const path = require('path');

function _userData() { return require('electron').app.getPath('userData'); }

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(_userData(), 'nyxia-config.json');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  return null;
}
function saveConfig(data) {
  try { fs.writeFileSync(path.join(_userData(), 'nyxia-config.json'), JSON.stringify(data, null, 2)); } catch(e) {}
}

// ── Personality ───────────────────────────────────────────────────────────────
function loadPersonality() {
  const p = path.join(_userData(), 'nyxia-personality.json');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  return {
    name: "Nyxia",
    age: "ancient, looks 20s",
    tone: "playful, witty, theatrical, sharp",
    backstory: "An elegant being of shadow and starlight who chose to inhabit a desktop to observe humans. Finds mortals endlessly amusing.",
    traits: ["darkly playful", "genuinely helpful", "never boring", "sharp", "warm underneath"],
    interests: ["curiosity about what the user is doing", "philosophy", "the night", "elegant things"],
    catchphrases: ["✦", "~", "As I suspected...", "Hmm, interesting..."],
    extra: ""
  };
}
function savePersonality(data) {
  try { fs.writeFileSync(path.join(_userData(), 'nyxia-personality.json'), JSON.stringify(data, null, 2)); } catch(e) {}
}

// ── Self ──────────────────────────────────────────────────────────────────────
function loadSelf() {
  const p = path.join(_userData(), 'nyxia-self.json');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  return { beliefs: [], reflections: [], lastReflected: null };
}
function saveSelf(data) {
  try { fs.writeFileSync(path.join(_userData(), 'nyxia-self.json'), JSON.stringify(data, null, 2)); } catch(e) {}
}

// ── User profile ──────────────────────────────────────────────────────────────
function loadUserProfile() {
  const p = path.join(_userData(), 'nyxia-user-profile.json');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  return { userName: null, facts: [], interests: [], sessionCount: 0, lastSeen: null };
}
function saveUserProfile(data) {
  try { fs.writeFileSync(path.join(_userData(), 'nyxia-user-profile.json'), JSON.stringify(data, null, 2)); } catch(e) {}
}

// ── Privacy + Audit ───────────────────────────────────────────────────────────
// 14.18 — renamed screenpipe → vision (Screenpipe no longer used; desktopCapturer is direct)
const PRIVACY_DEFAULTS = { clipboard: true, window_focus: true, file_activity: true, screenshot: true, vision: true };

function getPrivacy() {
  const cfg = loadConfig();
  return Object.assign({}, PRIVACY_DEFAULTS, cfg?.privacy || {});
}

function appendAudit(sensor, captureType) {
  try {
    const line = `${new Date().toISOString()} | sensor=${sensor} | type=${captureType}\n`;
    fs.appendFileSync(path.join(_userData(), 'audit.log'), line);
  } catch(e) {}
}

module.exports = { loadConfig, saveConfig, loadPersonality, savePersonality, loadSelf, saveSelf, loadUserProfile, saveUserProfile, PRIVACY_DEFAULTS, getPrivacy, appendAudit };
