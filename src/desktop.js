// desktop.js — Phase 4.4: Full desktop control
// Layer 1: spawn   — direct app launch
// Layer 2: dogtail — AT-SPI UI interaction (click, type, read state)
// Layer 3: ydotool — raw input fallback (Wayland-native, needs ydotoold running)

const { execSync, spawn } = require('child_process');
const path = require('path');

const YDOTOOL     = '/usr/bin/ydotool';
const DESKTOP_PY  = path.join(__dirname, '..', 'scripts', 'desktop_action.py');

// ── ydotoold daemon ──────────────────────────────────────────────────────────

function ensureYdotoold() {
  try {
    execSync('pgrep ydotoold', { stdio: 'ignore' });
  } catch {
    try {
      spawn('ydotoold', [], { detached: true, stdio: 'ignore' }).unref();
      execSync('sleep 0.6');
    } catch (e) {
      console.warn('[desktop] ydotoold start failed:', e.message);
    }
  }
}

// ── ydotool wrapper ──────────────────────────────────────────────────────────

function ydotool(...args) {
  return new Promise((resolve) => {
    ensureYdotoold();
    const proc = spawn(YDOTOOL, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { proc.kill(); resolve({ code: -1, err: 'timeout' }); }, 5000);
    proc.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

// ── AT-SPI Python bridge ─────────────────────────────────────────────────────

function callAtSPI(args) {
  return new Promise((resolve) => {
    const proc = spawn('python3', [DESKTOP_PY, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', d => out += d);
    const timer = setTimeout(() => { proc.kill(); resolve({ error: 'timeout' }); }, 10000);
    proc.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { resolve({ error: 'parse error: ' + out.slice(0, 100) }); }
    });
  });
}

// ── App launch ───────────────────────────────────────────────────────────────

function launchApp(name) {
  return new Promise((resolve) => {
    const proc = spawn(name, [], { detached: true, stdio: 'ignore' });
    proc.unref();
    proc.on('error', () => {
      const proc2 = spawn(name.toLowerCase(), [], { detached: true, stdio: 'ignore' });
      proc2.unref();
      proc2.on('error', (e) => resolve({ launched: false, error: e.message }));
      proc2.on('spawn', () => resolve({ launched: true, name: name.toLowerCase() }));
    });
    proc.on('spawn', () => resolve({ launched: true, name }));
    // Resolve after 600ms regardless — we can't easily tell if launch succeeded
    setTimeout(() => resolve({ launched: true, name }), 600);
  });
}

// ── Window focus via qdbus KWin ──────────────────────────────────────────────

async function focusWindow(title) {
  try {
    // Get window IDs matching title via xdotool (Xwayland) or KWin scripting
    const ids = execSync(
      `qdbus org.kde.KWin /KWin windowList 2>/dev/null | head -20`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    return `Looked for window "${title}". KWin window list: ${ids.slice(0, 200)}`;
  } catch {
    return `Attempted to focus "${title}" — window management unavailable.`;
  }
}

// ── Main entry: parse natural language and route ─────────────────────────────

async function desktopExecute(instruction) {
  const text = instruction.trim();

  // Open / launch app
  const launchMatch = text.match(/\b(?:open|launch|start|run)\s+([a-zA-Z][a-zA-Z0-9_\-.]+)/i);
  if (launchMatch) {
    const appName = launchMatch[1];
    const r = await launchApp(appName);
    return r.launched
      ? `Launched ${appName}. It should be opening now.`
      : `Tried to launch ${appName} but got an error: ${r.error}`;
  }

  // Switch / focus window
  const switchMatch = text.match(/\b(?:switch to|focus|bring up|show)\s+(.+)/i);
  if (switchMatch) {
    return await focusWindow(switchMatch[1].trim());
  }

  // Close app
  const closeMatch = text.match(/\b(?:close|quit|kill)\s+([a-zA-Z][a-zA-Z0-9_\-\s]+)/i);
  if (closeMatch) {
    const appName = closeMatch[1].trim();
    try {
      execSync(`pkill -f "${appName}" 2>/dev/null`, { timeout: 3000 });
      return `Closed ${appName}.`;
    } catch {
      return `Could not close ${appName} — process not found.`;
    }
  }

  // Click element in app: "click OK in Firefox"
  const clickInMatch = text.match(/\bclick\s+(?:the\s+)?["']?(.+?)["']?\s+(?:in|on|inside)\s+([a-zA-Z][a-zA-Z0-9_\-\s]+)/i);
  if (clickInMatch) {
    const label = clickInMatch[1].trim();
    const appName = clickInMatch[2].trim();
    const r = await callAtSPI({ action: 'click_element', app: appName, label });
    return r.success
      ? `Clicked "${label}" in ${appName}.`
      : `Tried to click "${label}" in ${appName}: ${r.error || 'not found'}`;
  }

  // Type text in app: "type hello world in gedit"
  const typeInMatch = text.match(/\btype\s+["']?(.+?)["']?\s+(?:in|into|inside)\s+([a-zA-Z][a-zA-Z0-9_\-\s]+)/i);
  if (typeInMatch) {
    const txt = typeInMatch[1].trim();
    const appName = typeInMatch[2].trim();
    const r = await callAtSPI({ action: 'type_text', app: appName, text: txt });
    if (r.success) return `Typed "${txt}" in ${appName}.`;
    // ydotool fallback
    const yr = await ydotool('type', '--delay', '30', '--', txt);
    return yr.code === 0 ? `Typed "${txt}" via keyboard (AT-SPI fallback).` : `Type failed: ${yr.err}`;
  }

  // Type without app target — use focused window
  const typeMatch = text.match(/\btype\s+["']?(.+?)["']?$/i);
  if (typeMatch) {
    const txt = typeMatch[1].trim();
    const yr = await ydotool('type', '--delay', '30', '--', txt);
    return yr.code === 0 ? `Typed "${txt}".` : `Type failed: ${yr.err}`;
  }

  // Press key: "press enter", "press ctrl+c"
  const keyMatch = text.match(/\bpress\s+(.+?)(?:\s+key)?$/i);
  if (keyMatch) {
    const key = keyMatch[1].trim().toLowerCase().replace(/\+/g, ':');
    const yr = await ydotool('key', key);
    return yr.code === 0 ? `Pressed ${keyMatch[1]}.` : `Key press failed: ${yr.err}`;
  }

  // List open apps
  if (/\b(what apps|list apps|what'?s? open|what'?s? running|open apps|running apps)\b/i.test(text)) {
    const r = await callAtSPI({ action: 'list_apps' });
    return r.apps
      ? `Open applications: ${r.apps.join(', ')}`
      : `Could not list apps: ${r.error}`;
  }

  // Read app state: "what does Firefox show"
  const readMatch = text.match(/\b(?:what'?s? in|read|check|look at|what does)\s+([a-zA-Z][a-zA-Z0-9_\-\s]+?)(?:\s+show|\s+say|\s+contain|\s+display|$)/i);
  if (readMatch) {
    const appName = readMatch[1].trim();
    const r = await callAtSPI({ action: 'read_state', app: appName });
    return r.found
      ? `${appName}: ${(r.content || []).slice(0, 8).join(' | ') || '(no readable text)'}`
      : `${appName} is not accessible or not running.`;
  }

  return 'I understood you want me to control the desktop, but I need a clearer instruction — open an app, click something, type text, or press a key.';
}

module.exports = { desktopExecute };
