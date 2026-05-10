'use strict';
// environment-state.js — Phase 20.3
// Infers session type, active project, and social context from sensory signals.
// Injected into prompt-builder to give Nyxia situational awareness of *what kind of moment* this is.

let _getMind     = null; // injected: () => mind instance
let _getWindow   = null; // injected: () => window title string
let _getClip     = null; // injected: () => clipboard text

const _PROJECT_RE = /\/([\w-]+)\s*(?:—|\||-|>)/;
const _IDE_APPS   = ['code', 'vscodium', 'neovim', 'vim', 'sublime', 'jetbrains', 'rider', 'pycharm', 'goland', 'cursor'];
const _BROWSER    = ['firefox', 'chromium', 'chrome', 'brave', 'opera'];
const _CREATIVE   = ['blender', 'krita', 'inkscape', 'gimp', 'kdenlive', 'davinci', 'figma', 'photoshop'];
const _TERMINAL   = ['konsole', 'alacritty', 'kitty', 'wezterm', 'gnome-terminal', 'xterm'];
const _CHAT_APPS  = ['discord', 'telegram', 'slack', 'signal', 'element', 'teams'];

/**
 * Classify window title into a session type.
 * Returns: 'coding' | 'browsing' | 'creative' | 'terminal' | 'social' | 'gaming' | 'conversational'
 */
function _classifyWindow(title = '') {
  const t = title.toLowerCase();
  if (_IDE_APPS.some(a => t.includes(a)))    return 'coding';
  if (_TERMINAL.some(a => t.includes(a)))    return 'terminal';
  if (_CREATIVE.some(a => t.includes(a)))    return 'creative';
  if (_CHAT_APPS.some(a => t.includes(a)))   return 'social';
  if (_BROWSER.some(a => t.includes(a)))     return 'browsing';
  if (/game|steam|lutris|heroic|proton/i.test(t)) return 'gaming';
  return 'conversational';
}

/**
 * Try to extract a project name from the window title.
 * e.g. "src/mind.js — nyxia — Visual Studio Code" → "nyxia"
 */
function _extractProject(title = '') {
  // Match "filename — project" or "project | ..."
  const m = title.match(/(?:—|\|)\s*([\w-]+)\s*(?:—|\||$)/);
  if (m && m[1].length > 1 && m[1] !== 'Code') return m[1];
  // Match path segment
  const p = title.match(/\/([a-z][\w-]+)\//i);
  if (p) return p[1];
  return null;
}

/**
 * Infer social context from recent clipboard or window.
 * Returns: 'alone' | 'pair' | 'group'
 */
function _inferSocial(clip = '', win = '') {
  const combined = (clip + ' ' + win).toLowerCase();
  if (/discord|slack|element|teams|meeting|zoom|call/i.test(combined)) return 'group';
  if (/telegram|signal|chat|message|dm/i.test(combined)) return 'pair';
  return 'alone';
}

/**
 * Get current environment state snapshot.
 * Returns { sessionType, project, social, windowTitle }
 */
function getEnvironmentState() {
  const win  = (_getWindow ? _getWindow() : '') || '';
  const clip = (_getClip   ? _getClip()   : '') || '';

  const sessionType = _classifyWindow(win);
  const project     = _extractProject(win);
  const social      = _inferSocial(clip, win);

  return { sessionType, project, social, windowTitle: win };
}

/**
 * Returns a compact string for prompt injection.
 * e.g. "coding session, project: nyxia, alone"
 */
function getEnvironmentContext() {
  const s = getEnvironmentState();
  const parts = [`${s.sessionType} session`];
  if (s.project) parts.push(`project: ${s.project}`);
  if (s.social !== 'alone') parts.push(s.social === 'pair' ? 'in a chat' : 'in a group context');
  return parts.join(', ');
}

function start({ getMind, getWindow, getClip } = {}) {
  if (getMind)    _getMind    = getMind;
  if (getWindow)  _getWindow  = getWindow;
  if (getClip)    _getClip    = getClip;
}

module.exports = { start, getEnvironmentState, getEnvironmentContext };
