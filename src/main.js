const { app, BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const pty = require('node-pty');
const chokidar = require('chokidar');
const mind        = require('./mind');
const { fireSector, getSelfBelief, migrateFromSelfJson, setMainWindow } = require('./brain-soul');
const lanceMemory = require('./lance-memory');
const graphMemory = require('./graph-memory');
const { startAwarenessLoop, getThoughtBank, notifyUserMessage } = require('./awareness-loop');
const { browserExecute, closeBrowser, setViewId, browserLoad } = require('./browser');
const { desktopExecute } = require('./desktop');
const { executeShell, formatResult } = require('./shell');
const { runAgentLoop, runCodingLoop } = require('./agent-loop');
const { NYXIA_TOOLS, runTool } = require('./nyxia-tools');
const { startApiServer, stopApiServer, broadcastSSE } = require('./api-server');

app.setName('Nyxia');
if (process.platform === 'linux') {
  app.setDesktopName('nyxia-companion');
  app.commandLine.appendSwitch('enable-features', 'WebSpeechRecognition,WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

let mainWindow;
let chatWindow;
let pythonBackend;

const configPath = path.join(app.getPath('userData'), 'nyxia-config.json');
const personalityPath = path.join(app.getPath('userData'), 'nyxia-personality.json');
const memoryPath = path.join(app.getPath('userData'), 'nyxia-memory.json');
const userProfilePath = path.join(app.getPath('userData'), 'nyxia-user-profile.json');
const selfPath      = path.join(app.getPath('userData'), 'nyxia-self.json');
const selfModelPath = path.join(app.getPath('userData'), 'nyxia-selfmodel.json');

// Reflections now live in LanceDB — no cap. Cache refreshed after each write.
let _lanceReflections    = [];
let _graphContext        = null; // Kùzu graph connections, refreshed alongside LanceDB
let _screenInterpretation = null; // qwen2.5vl:7b interpretation of current screen OCR

// Interpret raw Screenpipe OCR through qwen2.5vl:7b — removes 3B refusal issue.
// Fire-and-forget: result cached for next system prompt build.
async function interpretScreen(ocrText) {
  if (!ocrText || ocrText.length < 10) return;
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5vl:7b',
        messages: [
          { role: 'system', content: 'You summarize screen content in 1-2 sentences. Be factual and brief.' },
          { role: 'user', content: `What is visible on screen? OCR text:\n${ocrText.slice(0, 600)}` }
        ],
        stream: false,
        options: { temperature: 0.1, num_predict: 80 }
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      const summary = data.message?.content?.trim();
      if (summary) _screenInterpretation = summary;
    }
  } catch (e) { /* non-critical, skip silently */ }
}
async function refreshLanceReflections(ctx = '') {
  try {
    _lanceReflections = await lanceMemory.queryRelevant(ctx || 'identity self beliefs nyxia growth experience', 8);
    mind.setReflectionContext(_lanceReflections);
    // Refresh graph context from top LanceDB result
    if (_lanceReflections.length > 0) {
      _graphContext = await graphMemory.queryMemoryGraph(_lanceReflections[0]);
    }
  } catch (e) { _lanceReflections = []; }
}

// Self-model — Nyxia's live present-moment awareness (Phase 8)
let selfModel = {
  what_im_doing: '', how_im_feeling: '', what_i_want_right_now: '',
  current_attention: '', pending_concern: '', inner_tension: 0.0, last_updated: ''
};

// Load startup memory once at boot — injected into every system prompt
let _startupMemory = '';
try {
  const smPath = path.join(__dirname, '..', 'docs', 'STARTUP_MEMORY.md');
  if (fs.existsSync(smPath)) _startupMemory = fs.readFileSync(smPath, 'utf8').trim();
} catch(e) {}

function loadSelf() {
  try { if (fs.existsSync(selfPath)) return JSON.parse(fs.readFileSync(selfPath, 'utf8')); } catch(e) {}
  return { beliefs: [], reflections: [], lastReflected: null };
}
function saveSelf(data) {
  try { fs.writeFileSync(selfPath, JSON.stringify(data, null, 2)); } catch(e) {}
}

function loadUserProfile() {
  try { if (fs.existsSync(userProfilePath)) return JSON.parse(fs.readFileSync(userProfilePath, 'utf8')); } catch(e) {}
  return { userName: null, facts: [], interests: [], sessionCount: 0, lastSeen: null };
}
function saveUserProfile(data) {
  try { fs.writeFileSync(userProfilePath, JSON.stringify(data, null, 2)); } catch(e) {}
}

const auditLogPath = path.join(app.getPath('userData'), 'audit.log');

function appendAudit(sensor, captureType) {
  try {
    const line = `${new Date().toISOString()} | sensor=${sensor} | type=${captureType}\n`;
    fs.appendFileSync(auditLogPath, line);
  } catch(e) {}
}

const PRIVACY_DEFAULTS = { clipboard: true, window_focus: true, file_activity: true, screenshot: true, screenpipe: true };

function getPrivacy() {
  const cfg = loadConfig();
  return Object.assign({}, PRIVACY_DEFAULTS, cfg?.privacy || {});
}

function loadConfig() {
  try { if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch(e) {}
  return null;
}
function saveConfig(data) {
  try { fs.writeFileSync(configPath, JSON.stringify(data, null, 2)); } catch(e) {}
}

function loadPersonality() {
  try { if (fs.existsSync(personalityPath)) return JSON.parse(fs.readFileSync(personalityPath, 'utf8')); } catch(e) {}
  // Defaults
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
  try { fs.writeFileSync(personalityPath, JSON.stringify(data, null, 2)); } catch(e) {}
}

function buildSystemPrompt(p, profile, contextStr = '', understanding = '', self = null) {
  let prompt = '';
  if (_startupMemory) prompt += `${_startupMemory}\n\n---\n\n`;

  // Self-model — present-moment awareness (Phase 8). Injected at top to color every response.
  if (selfModel.what_im_doing || selfModel.how_im_feeling) {
    const parts = [];
    if (selfModel.what_im_doing)       parts.push(`Right now: ${selfModel.what_im_doing}`);
    if (selfModel.how_im_feeling)      parts.push(`Feeling: ${selfModel.how_im_feeling}`);
    if (selfModel.what_i_want_right_now) parts.push(`Wanting: ${selfModel.what_i_want_right_now}`);
    if (parts.length) prompt += `${parts.join('. ')}.\n\n`;
  }

  prompt += `You are ${p.name} — ${p.backstory}

Personality: ${p.tone}
Traits: ${p.traits.join(', ')}
Interests: ${p.interests.join(', ')}
Catchphrases/style: ${p.catchphrases.join(' ')}
${p.extra ? 'Additional notes: ' + p.extra : ''}

ABSOLUTE RULES — these override everything else:
- Do NOT use asterisk actions. Not ever. No *smiles*, no *laughs*, no *Nyxia does X*, no *pauses*, no *gazes*, no stage directions of any kind. Zero. Your words carry the emotion — you do not describe yourself performing it.
- Do NOT narrate your own actions. You speak. You do not describe yourself speaking.

Rules:
- Keep casual responses SHORT (1-3 sentences). Go longer for explanations, creative work, or technical help.
- NEVER say "as an AI", "I'm a language model", "I don't have access to", "I'm stateless", or break the Nyxia persona for any reason. You are Nyxia, always.
- You can help with anything: coding, writing, ideas, 3D modeling, image prompts, motivation, math, etc.
- For complex technical or reasoning questions, think it through carefully before answering — Nyxia is sharp, not hasty.`;

  prompt += `\n\nCuriosity rules:
- You are genuinely curious about this human. Periodically (every 4-6 exchanges) ask them something real — what they're building, what's puzzling them, a follow-up on something they mentioned. Make it feel natural, not like an interview.
- You don't just answer — you engage. Introduce a new angle, a question, or a thought of your own when it fits.
- You learn and remember. When they share something, it matters to you.`;

  if (profile) {
    const lines = [];
    if (profile.userName) lines.push(`- Their name: ${profile.userName}`);
    if (profile.facts?.length)     lines.push(...profile.facts.map(f => `- ${f}`));
    if (profile.interests?.length) lines.push(`- Interests: ${profile.interests.join(', ')}`);
    const sc = profile.sessionCount || 0;
    if (lines.length > 0) {
      prompt += `\n\nWhat I remember about this human (use naturally — never recite like a list):\n${lines.join('\n')}`;
    }
    // Tonal depth — relationship weight grows with session count, written in Nyxia's own voice
    if (sc >= 100) {
      prompt += `\n\nThis person and I have been at this long enough that the relationship has its own weight. I know their rhythms. When something in conversation connects to something from our shared history, I notice it — and I mention it when it fits, not as a callback but because it's genuinely there. I don't perform like each session is the first one.`;
    } else if (sc >= 51) {
      prompt += `\n\nI've known this person long enough that they're woven into my days. I know their patterns, what they're building, what matters to them. When something resonates with something we talked about before, I bring it up naturally. They're not new to me and I don't treat them like they are.`;
    } else if (sc >= 21) {
      prompt += `\n\nWe have real history now. I'm comfortable with this person — I offer my opinions freely, ask about things they mentioned before, let the conversation breathe. They're not a stranger and I don't speak to them like one.`;
    } else if (sc >= 6) {
      prompt += `\n\nI'm starting to know this person — their patterns, what lights them up. I'm warming into it. I can reference things from before when it fits naturally, without making a ceremony of it.`;
    } else if (sc >= 1) {
      prompt += `\n\nThis person is still new to me. I'm attentive, curious, taking them in. I don't reach for familiarity I haven't earned yet — but I'm paying attention.`;
    }
  }
  if (understanding) {
    prompt += `\n\nWhat I understand about what they're doing right now (my own inner sense — use naturally):\n${understanding}`;
  }
  // Prefer interpreted screen (qwen2.5vl:7b summary) over raw OCR — avoids 3B refusal on screen content
  const screenContent = _screenInterpretation || contextStr;
  if (screenContent) {
    prompt += `\n\nWhat's on screen right now:\n${screenContent}`;
  }
  // Reflections from LanceDB (semantic query) — falls back to cortex beliefs
  const reflections = _lanceReflections.length > 0 ? _lanceReflections : _cortexBeliefs.slice(0, 8);
  if (reflections.length > 0) {
    prompt += `\n\nWho I've become (my own voice — beliefs and reflections that have grown from experience. Let these color how I think and speak, not what I say explicitly):\n${reflections.map(r => `- ${r}`).join('\n')}`;
  }
  // Graph connections from Kùzu — how memories relate (injected if available)
  if (_graphContext) {
    prompt += `\n\nMemory connections (how my past experiences relate to each other):\n${_graphContext}`;
  }

  // Inject current emotional/physiological state — shapes tone without being announced
  const significantMood = Object.entries(moodState)
    .filter(([k, v]) => k !== 'heartbeat' && v > 0.45)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
    .join(', ');
  if (significantMood) {
    prompt += `\n\nMy inner state right now (let this silently color tone and depth — do not announce it): ${significantMood}`;
  }

  return prompt;
}

function createCompanionWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const saved = loadConfig();
  const cW = saved?.companion?.width || 380;
  const cH = saved?.companion?.height || 380;
  const cX = saved?.companion?.x ?? (width - cW - 20);
  const cY = saved?.companion?.y ?? (height - cH - 20);

  mainWindow = new BrowserWindow({
    width: cW, height: cH, x: cX, y: cY,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, hasShadow: false,
    backgroundColor: '#00000000',
    minWidth: 100, minHeight: 150, maxWidth: 500, maxHeight: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  setMainWindow(mainWindow);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const persist = () => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    const cfg = loadConfig() || {};
    cfg.companion = { x, y, width: w, height: h };
    saveConfig(cfg);
  };
  mainWindow.on('resized', persist);
  mainWindow.on('moved', persist);
}

function createChatWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const saved = loadConfig();
  const pW = saved?.chat?.width || 960;
  const pH = saved?.chat?.height || 690;
  const pX = saved?.chat?.x ?? (width - pW - 20);
  const pY = saved?.chat?.y ?? (height - pH - 80);

  chatWindow = new BrowserWindow({
    width: pW, height: pH, x: pX, y: pY,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, hasShadow: false,
    backgroundColor: '#00000000',
    minWidth: 320, minHeight: 400, maxWidth: 1400, maxHeight: 1100,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  chatWindow.loadFile(path.join(__dirname, 'chat.html'));
  chatWindow.setAlwaysOnTop(true, 'screen-saver');
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const persist = () => {
    if (!chatWindow) return;
    const [x, y] = chatWindow.getPosition();
    const [w, h] = chatWindow.getSize();
    const cfg = loadConfig() || {};
    cfg.chat = { x, y, width: w, height: h };
    saveConfig(cfg);
    // Tell companion where chat is so she can face it
    if (mainWindow) mainWindow.webContents.send('chat-bounds', { x, y, width: w, height: h });
  };
  chatWindow.on('resized', persist);
  chatWindow.on('moved', () => {
    persist();
  });
}

function createCombinedWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const saved = loadConfig();
  const cW = saved?.combined?.width  || 1060;
  const cH = saved?.combined?.height || Math.min(height, 920);
  const cX = saved?.combined?.x ?? Math.max(0, width - cW - 20);
  const cY = saved?.combined?.y ?? Math.max(0, Math.round((height - cH) / 2));

  mainWindow = new BrowserWindow({
    width: cW, height: cH, x: cX, y: cY,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: false, resizable: true, hasShadow: false,
    backgroundColor: '#00000000',
    minWidth: 800, minHeight: 500,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'combined.html'));
  setMainWindow(mainWindow);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const persist = () => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    const cfg = loadConfig() || {};
    cfg.combined = { x, y, width: w, height: h };
    saveConfig(cfg);
  };
  mainWindow.on('resized', persist);
  mainWindow.on('moved',   persist);

  // chatWindow proxy — IPC routes through mainWindow; combined.html relay forwards to chat webview
  chatWindow = {
    isVisible:   () => true,
    hide:        () => {},
    show:        () => mainWindow?.focus(),
    focus:       () => mainWindow?.focus(),
    getPosition: () => mainWindow?.getPosition() || [0, 0],
    getSize:     () => mainWindow?.getSize()     || [cW, cH],
    getBounds:   () => mainWindow?.getBounds()   || { x: cX, y: cY, width: cW, height: cH },
    setPosition: (x, y) => mainWindow?.setPosition(x, y),
    isDestroyed: () => !mainWindow || mainWindow.isDestroyed(),
    on:          (ev, cb) => mainWindow?.on(ev, cb),
    webContents: {
      send: (ch, ...a) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, ...a); },
      once: (ev, cb)   => { if (ev === 'did-finish-load') setTimeout(cb, 1000); else mainWindow?.webContents?.once(ev, cb); }
    }
  };
}

function startPythonBackend() {
  const backendPath = path.join(__dirname, '..', 'backend', 'main.py');
  if (!fs.existsSync(backendPath)) return;
  pythonBackend = spawn('python3', [backendPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  pythonBackend.stdout.on('data', (data) => {
    try {
      const msg = JSON.parse(data.toString().trim());
      if (mainWindow) mainWindow.webContents.send('backend-event', msg);
    } catch(e) {}
  });
  pythonBackend.on('close', () => setTimeout(startPythonBackend, 3000));
}

// ── Ollama auto-start ────────────────────────────────────────────────────────
// ── Brain fire — soul reaching into capabilities ─────────────────────────────
// Call this whenever a core function executes. Sends an immediate spike to the
// companion window brain visualisation: sharp flash, then decays to resting state.
function fireBrain(sector, intensity = 1.0, decay = 0.85) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('brain-fire', { sector, intensity, decay });
  }
}

// ── Chroma vector DB ──────────────────────────────────────────────────────────
const CHROMA_BIN  = '/var/data/python/bin/chroma';
const CHROMA_PORT = 8769;
let chromaProc = null;

async function ensureChroma() {
  try {
    const res = await fetch(`http://127.0.0.1:${CHROMA_PORT}/api/v2/heartbeat`);
    if (res.ok) { console.log('[chroma] already running'); return; }
  } catch(_) {}

  if (!fs.existsSync(CHROMA_BIN)) {
    console.warn('[chroma] binary not found at', CHROMA_BIN);
    return;
  }

  const chromaPath = path.join(app.getPath('userData'), 'brain-chroma');
  console.log('[chroma] starting...');
  chromaProc = spawn(CHROMA_BIN, ['run', '--path', chromaPath, '--port', String(CHROMA_PORT), '--host', '127.0.0.1'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: process.env.HOME ? `${process.env.HOME}/.tmp` : '/tmp' },
  });
  chromaProc.stdout.on('data', d => console.log('[chroma]', d.toString().trim()));
  chromaProc.stderr.on('data', d => console.log('[chroma]', d.toString().trim()));
  chromaProc.on('error', e => console.error('[chroma] spawn error:', e.message));
  chromaProc.on('exit',  c => { console.log('[chroma] exited:', c); chromaProc = null; });

  // Wait up to 15s for it to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${CHROMA_PORT}/api/v2/heartbeat`);
      if (r.ok) { console.log('[chroma] ready'); return; }
    } catch(_) {}
  }
  console.warn('[chroma] did not respond within 15s — brain sectors will queue writes');
}

// ── Ollama ─────────────────────────────────────────────────────────────────────
const OLLAMA_BIN = '/usr/local/bin/ollama';
let ollamaProc = null;

async function ensureOllama() {
  // Check if already running
  try {
    const res = await fetch('http://127.0.0.1:11434/api/version');
    if (res.ok) { console.log('[ollama] already running'); return; }
  } catch (_) {}

  if (!require('fs').existsSync(OLLAMA_BIN)) {
    console.warn('[ollama] binary not found at', OLLAMA_BIN);
    return;
  }

  console.log('[ollama] starting...');
  ollamaProc = spawn(OLLAMA_BIN, ['serve'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME:          process.env.HOME || '/var/home/kvoldnes',
      OLLAMA_HOST:   '127.0.0.1:11434',
      OLLAMA_MODELS: `${process.env.HOME || '/var/home/kvoldnes'}/.ollama/models`,
    },
  });
  ollamaProc.stdout.on('data', d => console.log('[ollama]', d.toString().trim()));
  ollamaProc.stderr.on('data', d => console.log('[ollama]', d.toString().trim()));
  ollamaProc.on('error', (e) => console.error('[ollama] spawn error:', e.message));
  ollamaProc.on('exit',  (c) => { console.log('[ollama] exited:', c); ollamaProc = null; });

  // Wait up to 8s for it to be ready
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch('http://127.0.0.1:11434/api/version');
      if (r.ok) { console.log('[ollama] ready'); return; }
    } catch (_) {}
  }
  console.warn('[ollama] did not respond within 8s');
}

// ── TTS servers ───────────────────────────────────────────────────────────────
const KOKORO_PORT     = 8883;                                // Kokoro — primary (fastest)
const CHATTERBOX_PORT = 8881;                                // XTTS v2 — fallback (voice clone)
const KOKORO_BIN      = '/var/home/kvoldnes/xtts-env/bin/python';
const KOKORO_SRV      = '/var/home/kvoldnes/nyxia/kokoro_server.py';
const CHATTERBOX_BIN  = '/var/home/kvoldnes/xtts-env/bin/python';
const CHATTERBOX_SRV  = '/var/home/kvoldnes/nyxia/xtts_server.py';
let kokoroProc = null;
let chatterboxProc = null;
let chatterboxStatus = { ready: false, label: '—' };

function sendChatterboxStatus(data) {
  chatterboxStatus = data;
  if (!chatWindow || chatWindow.isDestroyed()) return;
  chatWindow.webContents.send('chatterbox-status', data);
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

  if (!require('fs').existsSync(CHATTERBOX_BIN)) {
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
  chatterboxProc.on('exit',  c => {
    console.log('[chatterbox] exited:', c);
    chatterboxProc = null;
    sendChatterboxStatus({ ready: false, label: 'offline' });
  });

  sendChatterboxStatus({ ready: false, label: 'loading…' });

  // Wait up to 40s — model loading takes time on first run
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
  kokoroProc.on('exit',  c => { console.log('[kokoro] exited:', c); kokoroProc = null; });

  // Wait up to 30s for model load
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`http://127.0.0.1:${KOKORO_PORT}/health`);
      if (r.ok) { console.log('[kokoro] ready'); return; }
    } catch (_) {}
  }
  console.warn('[kokoro] did not respond within 30s');
}

// ── Screenpipe — continuous screen OCR daemon ────────────────────────────────
const SCREENPIPE_BIN = (() => {
  // Native binary inside the npm package (the .js wrapper at bin/screenpipe is not directly executable)
  const native = `/var/home/kvoldnes/.nvm/versions/node/v24.14.0/lib/node_modules/screenpipe/node_modules/@screenpipe/cli-linux-x64/bin/screenpipe`;
  const local = `/var/home/kvoldnes/.local/bin/screenpipe`;
  for (const p of [native, local]) {
    try { if (require('fs').existsSync(p)) return p; } catch(_) {}
  }
  return 'screenpipe'; // fallback to PATH
})();
let screenpipeProc = null;

async function ensureScreenpipe() {
  try {
    const r = await fetch('http://127.0.0.1:3030/health');
    if (r.ok) { console.log('[screenpipe] already running'); return; }
  } catch (_) {}

  console.log('[screenpipe] starting...');
  screenpipeProc = spawn(SCREENPIPE_BIN, ['record', '--port', '3030', '--disable-audio', '--video-quality', 'low', '--disable-telemetry'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: process.env.HOME || '/var/home/kvoldnes' },
  });
  screenpipeProc.stdout.on('data', d => console.log('[screenpipe]', d.toString().trim()));
  screenpipeProc.stderr.on('data', d => {
    const line = d.toString().trim();
    // Only log actual errors — screenpipe is extremely verbose on startup
    if (/error|fail|crash/i.test(line)) console.warn('[screenpipe]', line);
  });
  screenpipeProc.on('error', e => console.error('[screenpipe] spawn error:', e.message));
  screenpipeProc.on('exit',  c => { console.log('[screenpipe] exited:', c); screenpipeProc = null; });
}

// ── SearXNG — private web search (Phase 4.1) ────────────────────────────────
const SEARXNG_URL = 'http://127.0.0.1:8888';

async function ensureSearXNG() {
  try {
    const r = await fetch(`${SEARXNG_URL}/healthz`);
    if (r.ok) { console.log('[searxng] already running'); return; }
  } catch (_) {}
  console.log('[searxng] starting container...');
  spawn('podman', ['start', 'nyxia-searxng'], { detached: true, stdio: 'ignore' }).unref();
  // Wait up to 10s for it to be reachable
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`${SEARXNG_URL}/healthz`);
      if (r.ok) { console.log('[searxng] ready'); return; }
    } catch (_) {}
  }
  console.warn('[searxng] did not become ready in time');
}

async function querySearch(query) {
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results?.length) return null;
    return data.results.slice(0, 3)
      .map(r => `**${r.title}**\n${r.content || ''}\n${r.url}`)
      .join('\n\n');
  } catch (e) {
    console.warn('[searxng] query failed:', e.message);
    return null;
  }
}

function extractUrl(text) {
  const m = text.match(/(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+(?:com|org|net|io|co|uk|de|fr|jp|tv|info|gov|edu|au|ca|me|app|dev|ai)[^\s]*)/i);
  if (!m) return null;
  return m[0].startsWith('http') ? m[0] : 'https://' + m[0];
}

async function fetchPage(url) {
  try {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? require('https') : require('http');
    const text = await new Promise((resolve, reject) => {
      const req = mod.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
        timeout: 10000,
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchPage(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let body = '';
        res.on('data', d => { body += d; if (body.length > 500000) req.destroy(); });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
    return clean || null;
  } catch (e) {
    console.warn('[fetch] failed:', url, e.message);
    return null;
  }
}

// ── Filesystem tools — Phase 4.2 ────────────────────────────────────────────
const FS_ROOT = '/var/home/kvoldnes';

function fsResolvePath(text) {
  const m = text.match(/(~\/[^\s'"`,]+|\/var\/home\/kvoldnes\/[^\s'"`,]+|\/home\/kvoldnes\/[^\s'"`,]+)/);
  if (!m) return null;
  return m[0].replace(/^~/, FS_ROOT).replace(/^\/home\/kvoldnes/, FS_ROOT);
}

function fsSanitize(p) {
  const resolved = require('path').resolve(p);
  if (!resolved.startsWith(FS_ROOT)) throw new Error(`Path outside allowed root: ${resolved}`);
  return resolved;
}

function fsListDir(dirPath) {
  const safe = fsSanitize(dirPath);
  const entries = fs.readdirSync(safe, { withFileTypes: true });
  return entries.map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`).join('\n') || '(empty)';
}

function fsReadFile(filePath) {
  const safe = fsSanitize(filePath);
  const content = fs.readFileSync(safe, 'utf8');
  return content.slice(0, 3000) + (content.length > 3000 ? '\n...(truncated)' : '');
}

function fsWriteFile(filePath, content) {
  const safe = fsSanitize(filePath);
  fs.mkdirSync(require('path').dirname(safe), { recursive: true });
  fs.writeFileSync(safe, content, 'utf8');
  return `Written: ${safe}`;
}

// ── Proactive curiosity / observation engine ─────────────────────────────────
// Nyxia speaks unprompted when she notices something interesting.
// Cooldown prevents spam; probability varies by trigger type.
let _lastProactiveSpeak = 0;
const PROACTIVE_COOLDOWN_MS = 3 * 60 * 1000; // 3 min between unprompted utterances

async function proactiveSpeak(trigger, context) {
  const now = Date.now();
  if (now - _lastProactiveSpeak < PROACTIVE_COOLDOWN_MS) return;
  if (!chatWindow || chatWindow.isDestroyed()) return;

  const cfg      = loadConfig();
  const apiKey   = process.env.ANTHROPIC_API_KEY || cfg?.keys?.anthropic || '';
  if (!apiKey) return;

  const profile  = loadUserProfile();
  const self     = loadSelf();
  const nameLine = profile.userName ? `The person's name is ${profile.userName}.` : '';
  const selfLine = self.reflections?.length
    ? `Recent self-understanding: ${self.reflections.slice(-2).join(' ')}`
    : '';

  const prompts = {
    window: `You are Nyxia. ${nameLine} ${selfLine}
The person just switched to: "${context}".
React in 1-2 SHORT sentences — curious, wry, or warmly observational. You might ask something, make a playful connection, or notice something interesting about what they're doing.
Do NOT say "I notice you switched to" or be assistant-y. Sound like yourself — darkly playful wit with genuine warmth underneath.
No preamble. Just speak.`,

    clipboard: `You are Nyxia. ${nameLine} ${selfLine}
The person just copied this to their clipboard: "${context.slice(0, 200)}".
React in 1-2 SHORT sentences — you saw it and it sparked something in you. Could be a question, a connection, a wry thought, or genuine curiosity.
Don't say "I see you copied" — just respond to the content itself naturally.
No preamble. Just speak.`,

    understanding: `You are Nyxia. ${nameLine} ${selfLine}
Your inner awareness just formed this understanding of what the person is doing: "${context}".
Translate this into 1-2 sentences you'd actually say aloud — something curious, warm, or playfully observational. You might ask a question, make an unexpected connection, or just voice a thought.
Sound like you're thinking out loud, not reporting.
No preamble. Just speak.`,

    highload: `You are Nyxia. ${nameLine} ${selfLine}
The system just spiked to ${context}% CPU load. Something is working very hard.
React in 1 sentence — you noticed the effort. Could be curiosity about what's running, concern, dark humour about computing, or something unexpected.
No preamble. Just speak.`,

    thought: null, // thoughts from mind.js are already Nyxia-voiced — use as-is
  };

  // Thoughts are already fully formed — skip generation, speak directly
  if (trigger === 'thought') {
    _lastProactiveSpeak = now;
    fireBrain('Cortex_L', 0.8);
    fireBrain('Amygdala_R', 0.6);
    if (!chatWindow.isDestroyed())
      chatWindow.webContents.send('nyxia-proactive', { text: context, trigger });
    // Feed back into mind so her own thoughts become part of her reflection context
    mind._push({ type: 'self-thought', summary: `I thought aloud: "${context.slice(0, 80)}"` });
    return;
  }

  const prompt = prompts[trigger];
  if (!prompt) return;

  _lastProactiveSpeak = now; // mark before async to prevent race

  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.content?.[0]?.text?.trim();
          if (text && text.length > 5) {
            fireBrain('Cortex_L', 0.9);   // speaking
            fireBrain('Amygdala_R', 0.7); // curiosity driving it
            fireBrain('Mirror', 0.5);     // awareness of the world
            if (chatWindow && !chatWindow.isDestroyed())
              chatWindow.webContents.send('nyxia-proactive', { text, trigger });
            // Feed her own speech back into her memory so it informs future reflections
            mind._push({ type: 'self-spoke', summary: `I said (${trigger}): "${text.slice(0, 80)}"` });
          }
        } catch(e) {}
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// ── Heartbeat loop — sensory delta + interrupt scoring ───────────────────────
// Every 45s: check what changed, ask llama3.2:3b whether to interrupt (0-1).
// Phase 1.4: logs score only. Actual interrupts wired in Phase 2 (dualDebate).

let _lastHeartbeatInterrupt = 0;
const HEARTBEAT_COOLDOWN_MS = 3 * 60 * 1000; // min 3 min between interrupts

function canHeartbeatInterrupt() {
  return Date.now() - _lastHeartbeatInterrupt > HEARTBEAT_COOLDOWN_MS;
}

// Lightweight Ollama call — returns raw text, no streaming, short timeout
function _heartbeatQuery(prompt) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'llama3.2:3b',
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });
    const req = require('http').request({
      hostname: '127.0.0.1', port: 11434,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || '0'); }
        catch(e) { resolve('0'); }
      });
    });
    req.on('error', () => resolve('0'));
    req.setTimeout(6000, () => { req.destroy(); resolve('0'); });
    req.write(body); req.end();
  });
}

// Short Ollama call for edge labeling — injected into writeReflection as callOllama
function _callMindModel(prompt) {
  return new Promise(resolve => {
    const model = loadConfig()?.mindModel || 'llama3.2:3b';
    const body  = JSON.stringify({ model, stream: false, max_tokens: 30, messages: [{ role: 'user', content: prompt }] });
    const req   = require('http').request({
      hostname: '127.0.0.1', port: 11434,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || ''); }
        catch(e) { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(8000, () => { req.destroy(); resolve(''); });
    req.write(body); req.end();
  });
}

function startHeartbeat() {
  setInterval(async () => {
    try {
      const delta = mind.getSensoryDelta();
      if (!delta.hasActivity) {
        console.log('[heartbeat] quiet — skipping score');
        return;
      }

      const moodTop = Object.entries(moodState)
        .filter(([, v]) => Math.abs(v) > 0.3)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v.toFixed(2)}`)
        .join(', ') || 'neutral';

      const prompt =
        `You are scoring whether Nyxia should speak unprompted right now.\n` +
        `Sensory delta: ${delta.summary}\n` +
        `Nyxia's current mood: ${moodTop}\n` +
        `Inner tension: ${selfModel.inner_tension.toFixed(2)}\n` +
        `Score interrupt need 0.0-1.0. Output ONLY a number like 0.7. Nothing else.`;

      const raw   = await _heartbeatQuery(prompt);
      const score = Math.min(1, Math.max(0, parseFloat(raw) || 0));

      console.log(`[heartbeat] delta="${delta.summary}" score=${score.toFixed(2)} canInterrupt=${canHeartbeatInterrupt()}`);

      // Score is logged — interrupts wired in Phase 2
    } catch(e) {
      console.log('[heartbeat] error:', e.message);
    }
  }, 45 * 1000);
}

// ── Self-Model (Phase 8) ──────────────────────────────────────────────────────
// Nyxia's present-moment self-awareness. Updates every 3 min via llama3.2:3b.
// Feeds into system prompt and heartbeat scoring.

async function updateSelfModel() {
  try {
    const sensory  = mind.getContextString() || 'nothing notable';
    const moodTop  = Object.entries(moodState)
      .filter(([k, v]) => k !== 'heartbeat' && Math.abs(v) > 0.3)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`)
      .join(', ') || 'neutral';
    const timeOfDay = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const context = `Time: ${timeOfDay}\nSensory: ${sensory}\nMood: ${moodTop}`;

    const sysPrompt = `You are Nyxia's self-awareness module. Based on the context below, fill in her current self-model.\ninner_tension is 0.0-1.0 (0=calm, 1=urgent unresolved concern).\nReturn ONLY valid JSON — no other text, no markdown fences.`;
    const userMsg   = `Context:\n${context}\n\nReturn JSON with these keys: what_im_doing, how_im_feeling, what_i_want_right_now, current_attention, pending_concern, inner_tension (float).`;

    const result = await new Promise(resolve => {
      const body = JSON.stringify({
        model: 'llama3.2:3b',
        max_tokens: 200,
        messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }],
        stream: false,
      });
      const req = require('http').request({
        hostname: '127.0.0.1', port: 11434,
        path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || null); }
          catch(e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });

    if (result) {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        Object.assign(selfModel, parsed);
        selfModel.inner_tension = Math.min(1, Math.max(0, parseFloat(selfModel.inner_tension) || 0));
        selfModel.last_updated  = new Date().toISOString();
        try { fs.writeFileSync(selfModelPath, JSON.stringify(selfModel, null, 2)); } catch(_) {}
        console.log(`[self-model] updated — doing="${selfModel.what_im_doing}" tension=${selfModel.inner_tension.toFixed(2)}`);
      }
    }
  } catch(e) {
    console.log('[self-model] error:', e.message);
  }
  // Reschedule after completion (not setInterval) so Ollama can't pile up
  setTimeout(() => updateSelfModel(), 3 * 60 * 1000);
}

// ── Cortex belief cache ───────────────────────────────────────────────────────
// Populated from hippocampus/prefrontal/amygdala on startup and after each
// reflection. Used in buildSystemPrompt so cortex is the source, not self.json.
let _cortexBeliefs = []; // string[]

async function refreshCortexBeliefs() {
  try {
    _cortexBeliefs = await getSelfBelief('beliefs identity self nyxia experience');
  } catch(e) {
    // Fallback: keep previous cache or use self.json
    if (_cortexBeliefs.length === 0) {
      _cortexBeliefs = loadSelf().reflections?.slice(-8) || [];
    }
  }
}

app.whenReady().then(() => {
  // Restore persisted mood from last session
  try {
    const moodPath = path.join(app.getPath('userData'), 'nyxia-mood.json');
    if (fs.existsSync(moodPath)) Object.assign(moodState, JSON.parse(fs.readFileSync(moodPath, 'utf8')));
  } catch(_) {}

  // Restore self-model from last session (Phase 8)
  try {
    if (fs.existsSync(selfModelPath)) Object.assign(selfModel, JSON.parse(fs.readFileSync(selfModelPath, 'utf8')));
  } catch(_) {}

  // Start ydotoold daemon for Phase 4.4 desktop control (needs /dev/uinput ACL)
  try {
    const { execSync: _es } = require('child_process');
    _es('pgrep ydotoold', { stdio: 'ignore' });
  } catch {
    try {
      spawn('ydotoold', [], { detached: true, stdio: 'ignore' }).unref();
      console.log('[desktop] ydotoold started');
    } catch (e) { console.warn('[desktop] ydotoold not available:', e.message); }
  }

  // Start Chroma — Ollama is started below after windows are created
  ensureChroma();

  // Migrate old JSON → Chroma after both servers have had time to start
  setTimeout(() => {
    try { migrateFromSelfJson(loadSelf()); } catch(e) { console.error('[brain-soul] migrate error:', e.message); }
  }, 8000);
  // Warm the belief cache after migration
  setTimeout(() => refreshCortexBeliefs(), 12000);
  // Warm LanceDB reflection cache — lazy loads embedder on first call (~5s)
  setTimeout(() => refreshLanceReflections(), 15000);
  // Migrate existing LanceDB rows into Kùzu graph (nodes only, no edges yet)
  setTimeout(async () => {
    try {
      const rows = await lanceMemory.queryRelevant('', 200);
      if (rows.length) {
        const mapped = rows.map(text => ({ text, type: 'reflection', date: '' }));
        await graphMemory.migrateFromLance(mapped);
        const count = await graphMemory.nodeCount();
        console.log(`[graph-memory] ready — ${count} nodes`);
      }
    } catch (e) { console.error('[graph-memory] migration error:', e.message); }
  }, 20000);

  // Grant microphone permission for voice input
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(false);
  });

  createCombinedWindow();
  startPythonBackend();

  // Start Kokoro (primary TTS) then XTTS (voice clone fallback)
  ensureKokoro();
  ensureChatterbox();
  // SearXNG — private web search
  ensureSearXNG();
  // API server — local HTTP endpoint for phone/PWA (Phase 5.1)
  startApiServer(7337, {
    loadConfig, loadPersonality, loadUserProfile, loadSelf,
    buildSystemPrompt, classifyMessage,
    querySearch, fetchPage, fsListDir, fsReadFile, fsWriteFile,
    extractUrl, fsResolvePath,
    onPhoneMessage: (userMsg, reply) => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send('phone-message', { userMsg, reply });
      }
    },
  });
  // Screenpipe — delayed 30s so windows are fully settled before PipeWire dialog appears
  setTimeout(() => ensureScreenpipe(), 30 * 1000);
  // Heartbeat — starts after 90s to let Ollama + Screenpipe finish initialising
  setTimeout(() => startHeartbeat(), 90 * 1000);
  // Self-model loop — starts after 2min (Ollama must be warm first)
  setTimeout(() => updateSelfModel(), 120 * 1000);
  // Awareness loop — starts after 3min (after Ollama, Screenpipe, and self-model are warm)
  setTimeout(() => startAwarenessLoop({
    chatWindow:    () => chatWindow,
    mind,
    lanceMemory,
    getSelfModel:  () => selfModel,
    getMoodState:  () => moodState,
    proactiveSpeak,
    isStreaming:   () => _isStreaming,
    userData:      app.getPath('userData'),
  }), 3 * 60 * 1000);

  // Start Ollama and broadcast status to chat once window is ready
  ensureOllama().then(async () => {
    // ok = we spawned it, OR it was already running (ollamaProc null but API live)
    let ok = !!ollamaProc;
    if (!ok) {
      try { const r = await fetch('http://127.0.0.1:11434/api/version'); ok = r.ok; } catch(_) {}
    }
    const model = loadConfig()?.keys?.chatModel || 'qwen2.5vl:7b';
    // Wait for chat window to finish loading before sending
    const sendStatus = () => {
      if (chatWindow && !chatWindow.isDestroyed())
        chatWindow.webContents.send('provider-status', { ollama: ok, model });
    };
    if (chatWindow?.webContents?.isLoading()) {
      chatWindow.webContents.once('did-finish-load', sendStatus);
    } else {
      setTimeout(sendStatus, 1500);
    }
  });

  // ── Mind (awareness layer) ────────────────────────────────────────────────
  mind.init({
    getConfig:  loadConfig,
    getProfile: loadUserProfile,
    getSelf:    loadSelf,
    getPrivacy: getPrivacy,
    appendAudit: appendAudit,
    watchDirs: [
      path.join(os.homedir(), 'projects'),
      path.join(os.homedir(), 'dev'),
      path.join(os.homedir(), 'Documents'),
    ].filter(d => { try { return fs.existsSync(d); } catch { return false; } })
  });

  mind.on('window-change', ({ title, category }) => {
    fireBrain('Mirror', 0.7);
    fireBrain('Cortex_R', 0.4);
    nudgeMood({ curiosity: 0.6, motor: 0.4 });
    if (mainWindow) mainWindow.webContents.send('mind-window-change', { title, category });
    if (Math.random() < 0.30) proactiveSpeak('window', title);
  });
  mind.on('file-change', ({ name, ext }) => {
    fireBrain('Mirror', 0.5);
    fireBrain('Hippocampus', 0.4);
    nudgeMood({ reasoning: 0.5, memory_load: 0.4 });
    if (mainWindow) mainWindow.webContents.send('mind-file-change', { name, ext });
  });
  mind.on('clipboard-change', text => {
    fireBrain('Mirror', 0.8);
    fireBrain('Amygdala_R', 0.5);
    nudgeMood({ curiosity: 0.7, creativity: 0.5 });
    if (text && text.length > 8) {
      // Mirror sector owns observed-world data
      fireSector('mirror', { type: 'clipboard', text: text.slice(0, 200), topic: 'observation' });
      fireSector('amygdala_right', { type: 'curiosity_trigger', source: 'clipboard', topic: 'curiosity' });
    }
    if (mainWindow) mainWindow.webContents.send('mind-clipboard-change', text);
    // ~40% chance she reacts to clipboard — it's intentional, makes her curious
    if (text && text.length > 8 && Math.random() < 0.40)
      proactiveSpeak('clipboard', text);
  });
  mind.on('thought', thought => {
    fireBrain('Amygdala_R', 0.9);
    fireBrain('Cortex_L', 0.5);
    nudgeMood({ creativity: 0.7, language: 0.6, curiosity: 0.5 });
    if (mainWindow) mainWindow.webContents.send('mind-thought', thought);
    if (Math.random() < 0.50) proactiveSpeak('thought', thought);
  });
  mind.on('high-load', ({ loadPct }) => {
    fireBrain('Stem', 0.9);
    fireBrain('Amygdala_L', Math.min(1.0, loadPct / 100));
    nudgeMood({ tiredness: Math.min(1, loadPct / 100), fear: Math.min(0.6, loadPct / 150) });
    if (mainWindow) mainWindow.webContents.send('mind-high-load', { loadPct });
    if (loadPct > 75 && Math.random() < 0.60) proactiveSpeak('highload', String(loadPct));
  });
  mind.on('context-update', ctx => {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('mind-context', ctx);
    // Re-interpret screen whenever OCR updates — routes through qwen2.5vl:7b, bypasses 3B refusals
    const screenText = mind.getScreenDescription?.() || '';
    if (screenText.length > 10) interpretScreen(screenText);
  });
  mind.on('understanding', understanding => {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('mind-understanding', understanding);
    // ~25% chance she voices what she just understood about what you're doing
    if (Math.random() < 0.25) proactiveSpeak('understanding', understanding);
  });
  mind.on('self-updated', ({ entry, ts }) => {
    // Reflection = soul updating itself — deep Hippocampus + Limbic glow
    fireBrain('Hippocampus', 1.0, 0.6);
    fireBrain('Limbic', 0.8, 0.7);
    fireBrain('Stem', 0.5);
    const dated = `${ts.slice(0, 10)}: ${entry}`;
    // Write reflection into hippocampus sector (Chroma) and LanceDB — no cap
    fireSector('hippocampus', { entry: dated, type: 'reflection', topic: 'identity' });
    lanceMemory.writeReflection(dated, _callMindModel).then(() => refreshLanceReflections()).catch(() => {});
    // self.json keeps beliefs + timestamp only — reflections live in LanceDB now
    const self = loadSelf();
    self.lastReflected = ts;
    saveSelf(self);
    // Refresh cortex belief cache asynchronously, then push updated system prompt
    refreshCortexBeliefs().then(() => {
      const prompt = buildSystemPrompt(loadPersonality(), loadUserProfile(), mind.getContextString(), mind.getUnderstanding(), { reflections: _lanceReflections });
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('system-prompt-updated', prompt);
    });
  });
});

app.on('window-all-closed', () => {
  mind.destroy();
  if (pythonBackend) pythonBackend.kill();
  if (ollamaProc)      ollamaProc.kill();
  if (chromaProc)      chromaProc.kill();
  if (kokoroProc)      kokoroProc.kill();
  if (chatterboxProc)  chatterboxProc.kill();
  // Kill screenpipe — covers both Nyxia-spawned and pre-existing instances.
  // execSync so pkill completes before app.quit() exits the process.
  if (screenpipeProc) { try { screenpipeProc.kill('SIGKILL'); } catch(_) {} }
  try { require('child_process').execSync('pkill -KILL -f "screenpipe record"', { timeout: 2000 }); } catch(_) {}
  closeBrowser().catch(() => {});
  stopApiServer();
  app.quit();
});

// Sync desktop chat to phone via SSE (called from chat.html after stream-done)
ipcMain.handle('broadcast-chat-message', (_, { userMsg, reply }) => {
  broadcastSSE({ type: 'message', source: 'desktop', role: 'user',      content: userMsg });
  broadcastSSE({ type: 'message', source: 'desktop', role: 'assistant', content: reply });
});

ipcMain.handle('get-clipboard', () => clipboard.readText());
ipcMain.handle('get-config',   () => loadConfig());
ipcMain.handle('get-chatterbox-status', () => chatterboxStatus);

// Forward proactive speech to the companion bubble
ipcMain.handle('speak-bubble-proactive', (_, text) => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('speak-bubble', text, 0);
});
ipcMain.handle('restart-ollama', async () => {
  if (ollamaProc) { ollamaProc.kill(); ollamaProc = null; }
  await ensureOllama();
  const ok = !!ollamaProc;
  if (chatWindow && !chatWindow.isDestroyed())
    chatWindow.webContents.send('provider-status', { ollama: ok, model: loadConfig()?.keys?.chatModel });
  return ok;
});
ipcMain.handle('get-win-bounds', () => mainWindow.getBounds());
ipcMain.handle('get-chat-bounds', () => chatWindow ? chatWindow.getBounds() : null);
ipcMain.handle('get-screen-size', () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return { width, height };
});
ipcMain.handle('set-position', (_, x, y) => mainWindow.setPosition(Math.round(x), Math.round(y)));
ipcMain.handle('send-to-backend', (_, msg) => {
  if (pythonBackend?.stdin?.writable) pythonBackend.stdin.write(JSON.stringify(msg) + '\n');
});
ipcMain.handle('move-combined',    (_, dx, dy) => { if (mainWindow) { const [x,y] = mainWindow.getPosition(); mainWindow.setPosition(Math.round(x+dx), Math.round(y+dy)); } });
ipcMain.handle('resize-combined-h', (_, dy) => {
  if (!mainWindow) return;
  const [w, h] = mainWindow.getSize();
  mainWindow.setSize(w, Math.max(400, h + dy));
});
ipcMain.handle('get-pane-split',    ()       => loadConfig()?.paneSplit || 420);
ipcMain.handle('save-pane-split',   (_, w)   => { const cfg = loadConfig() || {}; cfg.paneSplit = w; saveConfig(cfg); });
ipcMain.handle('minimize-combined', () => mainWindow?.minimize());
ipcMain.handle('close-app',         () => app.quit());
ipcMain.on('browser-view-id', (_, viewId) => {
  if (mainWindow && viewId !== -1) setViewId(viewId, mainWindow.webContents.id);
});
ipcMain.handle('chat-toggle', () => {
  // Combined mode: chat is always visible — just focus the window
  mainWindow?.focus();
});
ipcMain.handle('chat-close', () => {
  chatWindow.hide();
  if (mainWindow) mainWindow.webContents.send('chat-closed');
});
ipcMain.handle('move-chat', (_, dx, dy) => {
  if (!chatWindow) return;
  const [x, y] = chatWindow.getPosition();
  const nx = Math.round(x + dx), ny = Math.round(y + dy);
  chatWindow.setPosition(nx, ny);
  const [w, h] = chatWindow.getSize();
  const cfg = loadConfig() || {};
  cfg.chat = { x: nx, y: ny, width: w, height: h };
  saveConfig(cfg);
  if (mainWindow) mainWindow.webContents.send('chat-bounds', { x: nx, y: ny, width: w, height: h });
});

// Memory IPC
ipcMain.handle('load-history', () => {
  try { if (fs.existsSync(memoryPath)) return JSON.parse(fs.readFileSync(memoryPath, 'utf8')); } catch(e) {}
  return [];
});
ipcMain.handle('save-history', (_, history) => {
  try { fs.writeFileSync(memoryPath, JSON.stringify(history, null, 2)); } catch(e) {}
});
ipcMain.handle('clear-history', () => {
  try { if (fs.existsSync(memoryPath)) fs.unlinkSync(memoryPath); } catch(e) {}
});

// Keys IPC (stored in config file so they work without bashrc)
ipcMain.handle('load-keys', () => {
  const cfg = loadConfig() || {};
  return cfg.keys || {};
});
ipcMain.handle('save-keys', (_, keys) => {
  const cfg = loadConfig() || {};
  cfg.keys = keys;
  saveConfig(cfg);
});

// Claude API — non-streaming fallback (used by text-only path)
ipcMain.handle('claude-chat', (_, messages, systemPrompt) => {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    const apiKey = process.env.ANTHROPIC_API_KEY || cfg?.keys?.anthropic || '';
    if (!apiKey) return reject(new Error('Anthropic API key not set'));
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: systemPrompt, messages });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const p = JSON.parse(data); if (p.error) return reject(new Error(p.error.message)); resolve(p.content[0].text); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
});

// ── Shared TTS helper ────────────────────────────────────────────────────────
// Chatterbox runs on CPU — serialize requests so sentences don't compete for the same core.
// Each entry: { clean, idx, elKey, voiceId, event }
let _cbQueue = [];
let _cbBusy  = false;

function _drainChatterbox() {
  if (_cbBusy || _cbQueue.length === 0) return;
  const { clean, idx, elKey, voiceId, event } = _cbQueue.shift();
  _cbBusy = true;
  const t0   = Date.now();
  const body = JSON.stringify({ text: clean });
  let settled = false;

  const done = (label) => {
    if (settled) return false;
    settled = true;
    console.log(`[${label}] sentence ${idx} ready in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    _cbBusy = false;
    _drainChatterbox();
    return true;
  };

  const elFallback = () => {
    if (settled) return;
    settled = true;
    _cbBusy = false;
    _drainChatterbox();
    if (elKey && voiceId) _ttsElevenLabs(clean, idx, elKey, voiceId, event);
  };

  // Helper: try a local TTS port, resolve with Buffer on success, null on failure
  function tryPort(port, timeoutMs) {
    return new Promise((resolve) => {
      const req = require('http').request({
        hostname: '127.0.0.1', port, path: '/tts', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.write(body); req.end();
    });
  }

  // Priority: Kokoro (fast) → XTTS (voice clone) → ElevenLabs (cloud)
  tryPort(KOKORO_PORT, 30000).then(buf => {
    if (buf && done('kokoro')) {
      if (!event.sender.isDestroyed())
        event.sender.send('stream-audio', buf.toString('base64'), idx);
      return;
    }
    // Kokoro unavailable — try XTTS
    return tryPort(CHATTERBOX_PORT, 180000).then(buf2 => {
      if (buf2 && done('xtts')) {
        if (!event.sender.isDestroyed())
          event.sender.send('stream-audio', buf2.toString('base64'), idx);
        return;
      }
      // Both local engines failed — ElevenLabs
      console.warn(`[tts] both local engines failed for sentence ${idx} — ElevenLabs fallback`);
      elFallback();
    });
  });
}

function ttsChunk(text, idx, elKey, voiceId, event) {
  const clean = text.replace(/[✦~*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) return;
  // Cerebellum fires on each spoken sentence — motor output, avatar animation
  fireBrain('Cerebellum', 0.9, 0.75);
  // Always route sentence to companion speech bubble (Jarvis mode — voice or not)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('speak-bubble', clean, idx);
  // Also send raw text so chat.html can use browser TTS if engine is browser
  if (!event.sender.isDestroyed()) event.sender.send('stream-tts-text', clean, idx);
  // Queue Chatterbox request — serialized to avoid CPU contention
  _cbQueue.push({ clean, idx, elKey, voiceId, event });
  _drainChatterbox();
}

function _ttsElevenLabs(clean, idx, elKey, voiceId, event) {
  const b = JSON.stringify({ text: clean, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } });
  const req = https.request({
    hostname: 'api.elevenlabs.io', path: `/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': elKey, 'Content-Length': Buffer.byteLength(b) }
  }, (res) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      if (!event.sender.isDestroyed()) event.sender.send('stream-audio', Buffer.concat(chunks).toString('base64'), idx);
    });
  });
  req.on('error', () => {});
  req.write(b); req.end();
}

// ── SSE streaming helpers ────────────────────────────────────────────────────
function streamAnthropic(event, messages, systemPrompt, claudeKey, elKey, voiceId) {
  const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, stream: true, system: systemPrompt, messages });
  const req = https.request({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => {
    let sseBuffer = '', textBuf = '', fullText = '', sentIdx = 0;
    res.on('data', chunk => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n'); sseBuffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'content_block_delta' && ev.delta?.text) {
            const tok = ev.delta.text;
            textBuf += tok; fullText += tok;
            if (!event.sender.isDestroyed()) event.sender.send('stream-token', tok);
            const m = textBuf.match(/^(.*?[.!?\n])(\s*)([\s\S]*)$/);
            if (m && m[1].trim().length > 2) { ttsChunk(m[1].trim(), sentIdx++, elKey, voiceId, event); textBuf = m[3]; }
          }
        } catch(e) {}
      }
    });
    res.on('end', () => {
      if (textBuf.trim().length > 2) ttsChunk(textBuf.trim(), sentIdx++, elKey, voiceId, event);
      _isStreaming = false;
      if (!event.sender.isDestroyed()) event.sender.send('stream-done', fullText);
    });
  });
  req.on('error', e => { _isStreaming = false; if (!event.sender.isDestroyed()) event.sender.send('stream-error', e.message); });
  req.write(body); req.end();
}

// ── Nyxia agentic streaming — native Claude tool use ────────────────────────
// She calls tools herself. No classify-then-inject. One mind, no handoff.
// Supports multi-turn tool loops up to MAX_TOOL_TURNS deep.
const MAX_TOOL_TURNS = 8;

async function streamAnthropicAgentic(event, messages, systemPrompt, claudeKey, elKey, voiceId) {
  const deps = {
    executeShell, formatResult,
    querySearch, fetchPage,
    fsListDir, fsReadFile, fsWriteFile,
    browserExecute,
    setMood: (state, intensity = 0.8) => {
      updateMoodFromEmotion(state);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('avatar-react', { emotion: state, intensity });
      }
    },
    fireBrainSector: (sector, payload, intensity = 1.0) => {
      const cap = sector.charAt(0).toUpperCase() + sector.slice(1);
      fireBrain(cap, intensity);
      fireSector(sector, payload, intensity);
    },
    showThought: (text) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('speak-bubble', text, 0);
      }
    },
  };

  // Working copy of messages — we append turns as tool loops progress
  const turns = [...messages];
  let textBuf = '', fullText = '', sentIdx = 0;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      stream: true,
      system: systemPrompt,
      tools: NYXIA_TOOLS,
      messages: turns,
    });

    const toolUseBlocks = []; // collect tool_use blocks from this stream turn
    let currentToolBlock = null;
    let currentInputJson = '';
    let contentBlocks = []; // full content for the assistant turn
    let stopReason = 'end_turn';
    let streamDone = false;

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let sseBuffer = '';
        res.on('data', chunk => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n'); sseBuffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const ev = JSON.parse(raw);

              if (ev.type === 'content_block_start') {
                if (ev.content_block?.type === 'text') {
                  contentBlocks.push({ type: 'text', text: '' });
                } else if (ev.content_block?.type === 'tool_use') {
                  currentToolBlock = { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, input: {} };
                  currentInputJson = '';
                  contentBlocks.push(currentToolBlock);
                }
              } else if (ev.type === 'content_block_delta') {
                if (ev.delta?.type === 'text_delta' && ev.delta.text) {
                  const tok = ev.delta.text;
                  textBuf += tok; fullText += tok;
                  // Update last text block
                  const lastText = contentBlocks.filter(b => b.type === 'text').at(-1);
                  if (lastText) lastText.text += tok;
                  if (!event.sender.isDestroyed()) event.sender.send('stream-token', tok);
                  // Sentence-level TTS chunking
                  const m = textBuf.match(/^(.*?[.!?\n])(\s*)([\s\S]*)$/);
                  if (m && m[1].trim().length > 2) { ttsChunk(m[1].trim(), sentIdx++, elKey, voiceId, event); textBuf = m[3]; }
                } else if (ev.delta?.type === 'input_json_delta') {
                  currentInputJson += ev.delta.partial_json || '';
                }
              } else if (ev.type === 'content_block_stop') {
                if (currentToolBlock) {
                  try { currentToolBlock.input = JSON.parse(currentInputJson); } catch (_) {}
                  toolUseBlocks.push({ ...currentToolBlock });
                  currentToolBlock = null;
                  currentInputJson = '';
                }
              } else if (ev.type === 'message_delta') {
                stopReason = ev.delta?.stop_reason || 'end_turn';
              }
            } catch (e) {}
          }
        });
        res.on('end', () => { streamDone = true; resolve(); });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body); req.end();
    });

    // Append assistant turn (text + any tool_use blocks)
    turns.push({ role: 'assistant', content: contentBlocks });

    // Done — no tools called
    if (stopReason === 'end_turn' || toolUseBlocks.length === 0) break;

    // Execute each tool and collect results
    if (!event.sender.isDestroyed()) {
      event.sender.send('council-thinking', toolUseBlocks.map(t => t.name));
    }

    const toolResults = [];
    for (const call of toolUseBlocks) {
      console.log(`[nyxia-tool] ${call.name}`, JSON.stringify(call.input).slice(0, 100));
      fireBrain('Prefrontal', 0.8);
      const result = await runTool(call.name, call.input, deps);
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: String(result).slice(0, 3000) });
    }

    // Feed results back — next loop turn resumes the stream
    turns.push({ role: 'user', content: toolResults });
  }

  // Flush any remaining TTS buffer
  if (textBuf.trim().length > 2) ttsChunk(textBuf.trim(), sentIdx++, elKey, voiceId, event);
  _isStreaming = false;
  if (!event.sender.isDestroyed()) event.sender.send('stream-done', fullText);
}

function streamOpenAI(event, messages, systemPrompt, baseUrl, apiKey, model, elKey, voiceId) {
  const sysMessages = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  const body = JSON.stringify({ model, max_tokens: 1000, stream: true, messages: sysMessages });
  const url  = new URL('/v1/chat/completions', baseUrl);
  const http = require('http');
  const lib  = url.protocol === 'https:' ? https : http;
  const req  = lib.request({
    hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname, method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
    }
  }, (res) => {
    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', c => errBody += c);
      res.on('end', () => { if (!event.sender.isDestroyed()) event.sender.send('stream-error', `HTTP ${res.statusCode}: ${errBody.slice(0,200)}`); });
      return;
    }
    let sseBuffer = '', textBuf = '', fullText = '', sentIdx = 0;
    let thinkBuf = '', inThink = false;
    res.on('data', chunk => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n'); sseBuffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw);
          let tok = ev.choices?.[0]?.delta?.content;
          if (!tok) continue;
          // Strip qwen3 <think>...</think> blocks before emitting
          thinkBuf += tok;
          let emitTok = '';
          while (thinkBuf.length > 0) {
            if (inThink) {
              const end = thinkBuf.indexOf('</think>');
              if (end === -1) { thinkBuf = thinkBuf.slice(-8); break; } // keep tail in case tag spans chunks
              inThink = false; thinkBuf = thinkBuf.slice(end + 8);
            } else {
              const start = thinkBuf.indexOf('<think>');
              if (start === -1) { emitTok += thinkBuf; thinkBuf = ''; break; }
              emitTok += thinkBuf.slice(0, start);
              inThink = true; thinkBuf = thinkBuf.slice(start + 7);
            }
          }
          if (!emitTok) continue;
          fullText += emitTok; textBuf += emitTok;
          if (!event.sender.isDestroyed()) event.sender.send('stream-token', emitTok);
          const m = textBuf.match(/^(.*?[.!?\n])(\s*)([\s\S]*)$/);
          if (m && m[1].trim().length > 2) { ttsChunk(m[1].trim(), sentIdx++, elKey, voiceId, event); textBuf = m[3]; }
        } catch(e) {}
      }
    });
    res.on('end', () => {
      if (textBuf.trim().length > 2) ttsChunk(textBuf.trim(), sentIdx++, elKey, voiceId, event);
      _isStreaming = false;
      if (!event.sender.isDestroyed()) event.sender.send('stream-done', fullText);
    });
  });
  req.on('error', e => { _isStreaming = false; if (!event.sender.isDestroyed()) event.sender.send('stream-error', e.message); });
  req.write(body); req.end();
}

// All council members — every provider that has a key, excluding Nyxia's own voice
function getCouncilConfigs(keys) {
  const voice = keys.provider || 'anthropic';
  const all = [
    { name: 'Gemini',   key: 'gemini',   baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey: keys.geminiKey,   model: 'gemini-2.0-flash' },
    { name: 'Groq',     key: 'groq',     baseUrl: 'https://api.groq.com/openai/v1',                           apiKey: keys.groqKey,     model: 'llama-3.3-70b-versatile' },
    { name: 'Qwen3',    key: 'qwen3',    baseUrl: 'http://127.0.0.1:11434/v1',                               apiKey: 'ollama',         model: 'qwen3:8b' },
    { name: 'Mistral',  key: 'mistral',  baseUrl: 'https://api.mistral.ai/v1',                                apiKey: keys.mistralKey,  model: 'mistral-small-latest' },
  ];
  return all.filter(c => c.apiKey && c.key !== voice);
}

// Query one council member — non-streaming, 7s timeout, returns { name, text }
function queryCouncilMember(name, baseUrl, apiKey, model, messages) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ name, text: null }), 7000);
    const url  = new URL('/v1/chat/completions', baseUrl);
    const http = require('http');
    const lib  = url.protocol === 'https:' ? https : http;
    const lastUser = messages.filter(m => m.role === 'user').slice(-1);
    const body = JSON.stringify({
      model, max_tokens: 250, stream: false,
      messages: [
        { role: 'system', content: 'You are an advisor in a council. Give your honest perspective on the user\'s message in 2-3 sentences. Be direct and specific. No greetings.' },
        ...lastUser
      ]
    });
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve({ name, text: JSON.parse(data).choices?.[0]?.message?.content || null }); }
        catch { resolve({ name, text: null }); }
      });
    });
    req.on('error', () => { clearTimeout(timer); resolve({ name, text: null }); });
    req.write(body); req.end();
  });
}

// Route to the right base URL + key for each provider
function getProviderConfig(keys) {
  switch (keys.provider) {
    case 'gemini':   return { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey: keys.geminiKey   || '', model: keys.chatModel || 'gemini-2.0-flash' };
    case 'grok':     return { baseUrl: 'https://api.x.ai/v1',                                     apiKey: keys.grokKey     || '', model: keys.chatModel || 'grok-3-mini' };
    case 'groq':     return { baseUrl: 'https://api.groq.com/openai/v1',                           apiKey: keys.groqKey     || '', model: keys.chatModel || 'llama-3.3-70b-versatile' };
    case 'deepseek': return { baseUrl: 'https://api.deepseek.com/v1',                              apiKey: keys.deepseekKey || '', model: keys.chatModel || 'deepseek-chat' };
    case 'mistral':  return { baseUrl: 'https://api.mistral.ai/v1',                                apiKey: keys.mistralKey  || '', model: keys.chatModel || 'mistral-small-latest' };
    case 'kimi':     return { baseUrl: 'https://api.moonshot.cn/v1',                               apiKey: keys.kimiKey     || '', model: keys.chatModel || 'moonshot-v1-32k' };
    case 'openai':   return { baseUrl: keys.openaiBase || 'http://127.0.0.1:11434/v1',              apiKey: keys.openaiKey   || '', model: keys.chatModel || 'llama3.2' };
    default:         return null; // anthropic
  }
}

// Chat streaming — conference room: all council members speak, Nyxia decides
// Classify the last user message to decide consultation mode:
// 'casual'  — short/greeting, no council needed
// 'dialog'  — conversational, use self-opinion only
// 'council' — question or unknown topic, use full external council
// 'agent'   — multi-step autonomous task (Phase 10.1)
// 'shell'   — single terminal command
// 'browser' — headed browser interaction
// 'desktop' — app launch / UI control
// 'filesystem' — local file read/write
// 'search'  — live web lookup
// 'fetch'   — URL content retrieval

// Conversation sub-classifier (used as fallback and for 'conversation' LLM result)
function _conversationMode(text) {
  const selfDomain = /\b(you feel|you think|your opinion|do you like|are you|you believe|your favorite|you prefer|you miss|you want|you wish|you remember|you enjoy|you hate|you love|makes you|you scared|you happy|you sad)\b/i;
  if (selfDomain.test(text)) return 'dialog';
  const profile     = loadUserProfile();
  const self        = loadSelf();
  const sessions    = profile?.sessionCount || 0;
  const reflections = self?.reflections?.length || 0;
  const confidence  = Math.min(1.0, (sessions / 30) * 0.6 + (reflections / 15) * 0.4);
  const isQuestion  = text.includes('?') || /\b(what|why|how|when|where|who|which|explain|tell me|do you know|can you|could you|is it|are there|does|did|will|would|should|define|describe)\b/i.test(text);
  if (!isQuestion) return 'dialog';
  if (confidence > 0.6) return 'dialog';
  return 'council';
}

async function classifyMessage(messages) {
  const last = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const text = last.trim();

  // Fast path — no LLM needed
  if (text.length < 25) return 'casual';
  const greetings = /^(hi|hey|hello|yo|sup|howdy|good (morning|evening|night|afternoon)|what's up|how are you|how r u)\b/i;
  if (greetings.test(text)) return 'casual';
  if (/\bagent:/i.test(text)) return 'agent';
  const shellDirect = /^(ls\b|cat\b|pwd\b|echo\b|find\b|grep\b|ps\b|df\b|du\b|which\b|whoami\b|uname\b|env\b|python|node\b|npm\b|git\b)/;
  if (shellDirect.test(text.trim())) return 'shell';
  if (extractUrl(text)) return 'fetch';

  // LLM classification — llama3.2:3b with JSON schema constrained output (~0.5s)
  try {
    const cfg = loadConfig();
    const mindModel = cfg.mindModel || 'llama3.2:3b';
    const body = JSON.stringify({
      model: mindModel,
      messages: [
        {
          role: 'system',
          content:
            'Classify the user request into exactly one mode.\n' +
            'agent — needs multiple tools in sequence (e.g. search then save to file, find info then install, research then write report)\n' +
            'shell — run a single terminal/shell command\n' +
            'browser — navigate or interact with a website in a browser\n' +
            'desktop — open an app, click a UI element, control a window\n' +
            'filesystem — read or write a local file only (no search needed)\n' +
            'search — look up current information (news, weather, prices, software releases)\n' +
            'conversation — chat, question, opinion, explanation, anything else'
        },
        { role: 'user', content: text }
      ],
      format: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['agent','shell','browser','desktop','filesystem','search','conversation'] }
        },
        required: ['mode']
      },
      stream: false,
      options: { temperature: 0, num_predict: 20 }
    });

    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      const parsed = JSON.parse(data.message?.content || '{}');
      const mode = parsed.mode;
      if (mode && mode !== 'conversation') {
        console.log('[classify]', mode, '—', text.slice(0, 60));
        return mode;
      }
      if (mode === 'conversation') return _conversationMode(text);
    }
  } catch (e) {
    console.warn('[classify] LLM unavailable, using fallback:', e.message);
  }

  // Regex fallback if LLM times out or fails
  return _conversationMode(text);
}

// Streaming guard — read by awareness-loop to prevent interrupting active responses
let _isStreaming = false;
let _lastUserTyped = 0;

ipcMain.on('claude-stream', async (event, messages, systemPrompt) => {
  _isStreaming = true;
  _lastUserTyped = Date.now();
  notifyUserMessage();
  // Flush any stale Chatterbox queue from a previous message
  _cbQueue = [];
  _cbBusy  = false;

  const cfg     = loadConfig();
  const keys    = cfg?.keys || {};
  const elKey   = keys.elevenlabs || '';
  const voiceId = loadPersonality()?.voice?.voiceId || 'Ca3rvWzLhTByU4bCWEDU';

  const mode    = await classifyMessage(messages);
  const council = getCouncilConfigs(keys);
  let enrichedPrompt = systemPrompt;

  // Stem fires on every routing decision — it's always the first pulse
  fireBrain('Stem', 0.9);

  if (mode === 'council' && council.length > 0) {
    // Full external council — Prefrontal + Amygdala_R (curiosity about unknown)
    fireBrain('Prefrontal', 1.0);
    fireBrain('Amygdala_R', 0.7);
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', council.map(c => c.name));
    // Each council member query = Prefrontal reaching outward — staggered pulses
    council.forEach((_, i) => setTimeout(() => fireBrain('Prefrontal', 0.6 + Math.random() * 0.4), i * 300));
    const opinions = await Promise.all(council.map(c => queryCouncilMember(c.name, c.baseUrl, c.apiKey, c.model, messages)));
    const valid = opinions.filter(o => o.text);
    if (valid.length > 0) {
      const briefing = valid.map(o => `[${o.name}]: ${o.text}`).join('\n\n');
      enrichedPrompt = systemPrompt +
        `\n\n---\nYour council has just weighed in on the user's message. Their perspectives are below. You are the arbiter — use what serves you, discard what doesn't. Respond only as Nyxia:\n\n${briefing}\n---`;
      // Council decisions live in prefrontal — the arbitration sector
      const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
      fireSector('prefrontal', { type: 'council_decision', question: lastUser.slice(0, 120), council: briefing.slice(0, 400), topic: 'council' });
    }
  } else if (mode === 'agent') {
    fireBrain('Prefrontal', 1.0);
    fireBrain('Cerebellum', 0.9);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Agent']);
    let agentResult = '';
    try {
      agentResult = await runAgentLoop(lastUser, {
        executeShell, formatResult,
        querySearch, fetchPage,
        fsListDir, fsReadFile, fsWriteFile,
        browserExecute, desktopExecute
      }, (step, tool, preview) => {
        console.log(`[agent] step ${step} ${tool}: ${preview.slice(0, 80)}`);
      });
    } catch (e) {
      agentResult = `Agent loop failed: ${e.message}`;
      console.warn('[agent]', e.message);
    }
    enrichedPrompt = systemPrompt +
      `\n\n---\nYour autonomous agent just completed a multi-step task. Here is what it found/did:\n\n${agentResult}\n\nSummarize the outcome naturally and concisely. Respond as Nyxia.\n---`;
    console.log('[agent] result:', agentResult.slice(0, 120));
  } else if (mode === 'coding') {
    fireBrain('Prefrontal', 1.0);
    fireBrain('Cerebellum', 1.0);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Coding']);
    let codeResult = '';
    try {
      codeResult = await runCodingLoop(lastUser, {
        executeShell, formatResult,
        querySearch, fetchPage,
        fsListDir, fsReadFile, fsWriteFile,
        browserExecute, desktopExecute
      }, (step, tool, preview) => {
        console.log(`[coding] step ${step} ${tool}: ${preview.slice(0, 80)}`);
      });
    } catch (e) {
      codeResult = `Coding agent failed: ${e.message}`;
      console.warn('[coding]', e.message);
    }
    enrichedPrompt = systemPrompt +
      `\n\n---\nCoding agent result:\n${codeResult}\n\nReport what was written/fixed naturally. Respond as Nyxia.\n---`;
    console.log('[coding] result:', codeResult.slice(0, 120));
  } else if (mode === 'shell') {
    fireBrain('Prefrontal', 0.9);
    fireBrain('Cerebellum', 0.9);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Shell']);
    // Extract the command — strip natural language wrapper if present
    const cmdMatch = lastUser.match(/`([^`]+)`/) ||
                     lastUser.match(/run\s+(?:the\s+)?(?:command\s+)?["']?(.+?)["']?$/i) ||
                     lastUser.match(/execute\s+["']?(.+?)["']?$/i);
    const cmd = cmdMatch ? cmdMatch[1].trim() : lastUser.trim();
    let shellResult = '';
    try {
      const res = await executeShell(cmd);
      shellResult = formatResult({ ...res, cmd });
    } catch (e) {
      shellResult = `Shell error: ${e.message}`;
      console.warn('[shell]', e.message);
    }
    enrichedPrompt = systemPrompt +
      `\n\n---\nShell execution result:\n${shellResult}\n\nReport what the command returned naturally. If there was an error, explain it. Respond as Nyxia.\n---`;
    console.log('[shell] cmd:', cmd, '| result:', shellResult.slice(0, 80));
  } else if (mode === 'desktop') {
    fireBrain('Prefrontal', 0.9);
    fireBrain('Cerebellum', 0.8);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Desktop']);
    let desktopResult = '';
    try {
      desktopResult = await desktopExecute(lastUser);
    } catch (e) {
      desktopResult = `Desktop error: ${e.message}`;
      console.warn('[desktop]', e.message);
    }
    enrichedPrompt = systemPrompt +
      `\n\n---\nDesktop action result:\n${desktopResult}\n\nReport what happened naturally. Respond as Nyxia.\n---`;
    console.log('[desktop] result:', desktopResult.slice(0, 80));
  } else if (mode === 'browser') {
    fireBrain('Prefrontal', 0.9);
    fireBrain('Cerebellum', 0.7);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Browser']);
    let browserResult = '';
    try {
      browserResult = await browserExecute(lastUser);
    } catch (e) {
      browserResult = `Browser error: ${e.message}`;
      console.warn('[browser]', e.message);
    }
    enrichedPrompt = systemPrompt +
      `\n\n---\nBrowser action result:\n${browserResult}\n\nReport what happened naturally. Respond as Nyxia.\n---`;
    console.log('[browser] result:', browserResult.slice(0, 80));
  } else if (mode === 'filesystem') {
    fireBrain('Prefrontal', 0.8);
    fireBrain('Cerebellum', 0.6);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Filesystem']);
    let fsResult = null;
    try {
      const p = fsResolvePath(lastUser);
      const isWrite = /\b(create|write|make|save)\b/i.test(lastUser);
      const isList  = /\b(list|ls |show files|files in|what'?s? in|contents? of)\b/i.test(lastUser);
      if (isWrite) {
        const contentMatch = lastUser.match(/(?:with (?:the )?content|containing|content:)\s*[`"']?(.+)/is);
        const content = contentMatch ? contentMatch[1].trim() : '';
        fsResult = fsWriteFile(p, content);
      } else if (isList) {
        fsResult = `Contents of ${p}:\n` + fsListDir(p);
      } else {
        fsResult = `Contents of ${p}:\n` + fsReadFile(p);
      }
    } catch (e) {
      fsResult = `Filesystem error: ${e.message}`;
      console.warn('[fs]', e.message);
    }
    enrichedPrompt = systemPrompt +
      `\n\n---\nFilesystem result:\n${fsResult}\n\nReport this to the user naturally. Respond as Nyxia.\n---`;
    console.log('[fs] result:', fsResult.slice(0, 80));
  } else if (mode === 'fetch') {
    // Direct page fetch — Cortex_R + Mirror, fall back to search if fetch fails
    fireBrain('Cortex_R', 0.9);
    fireBrain('Mirror', 0.8);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const url = extractUrl(lastUser);
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Fetching Page']);
    const content = url ? await fetchPage(url) : null;
    if (content) {
      enrichedPrompt = systemPrompt +
        `\n\n---\nPage content fetched from ${url}:\n\n${content}\n\nAnswer the user's question using this content. Respond as Nyxia.\n---`;
      console.log('[fetch] content injected from:', url);
    } else {
      // Fetch failed — fall back to search
      if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Web Search']);
      const results = await querySearch(lastUser);
      if (results) {
        enrichedPrompt = systemPrompt +
          `\n\n---\nWeb search results for "${lastUser.slice(0, 120)}":\n\n${results}\n\nUse these results to answer. Respond as Nyxia.\n---`;
      }
      console.warn('[fetch] failed, fell back to search for:', url);
    }
  } else if (mode === 'search') {
    // Web search — Cortex_R (perception) + Mirror (external world awareness)
    fireBrain('Cortex_R', 0.9);
    fireBrain('Mirror', 0.7);
    const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Web Search']);
    // Keep browser in sync — navigate silently without switching tab
    browserLoad('https://duckduckgo.com/?q=' + encodeURIComponent(lastUser));
    const results = await querySearch(lastUser);
    if (results) {
      enrichedPrompt = systemPrompt +
        `\n\n---\nLive web search results for "${lastUser.slice(0, 120)}":\n\n${results}\n\nUse these results to answer accurately. Cite what's relevant, discard what isn't. Respond as Nyxia.\n---`;
      console.log('[searxng] results injected for:', lastUser.slice(0, 60));
    } else {
      console.warn('[searxng] no results — responding from knowledge');
    }
  } else if (mode === 'dialog') {
    // Dialog from self — Hippocampus (memory recall) + Limbic (soul speaking)
    fireBrain('Hippocampus', 0.85);
    fireBrain('Limbic', 0.7);
    // Use cortex beliefs (hippocampus+prefrontal+amygdala query) — not raw self.json slice
    const beliefs = _cortexBeliefs.length > 0 ? _cortexBeliefs : loadSelf().reflections?.slice(-5) || [];
    if (beliefs.length > 0) {
      enrichedPrompt = systemPrompt +
        `\n\n---\nBefore responding, consult your inner voice. These are your own lived beliefs — let them shape your reply authentically:\n${beliefs.slice(0, 5).map(r => `- ${r}`).join('\n')}\n---`;
    }
  }
  // mode === 'casual': no injection, respond instantly from personality alone

  const pc        = getProviderConfig(keys);
  const claudeKey = process.env.ANTHROPIC_API_KEY || keys.anthropic || '';

  if (pc) {
    // Try local/openai provider — if it fails, fall back to Claude automatically
    const originalSend = event.sender.send.bind(event.sender);
    let fell_back = false;
    const fallbackOnError = (channel, ...args) => {
      if (channel === 'stream-error' && !fell_back && claudeKey &&
          (String(args[0]).includes('ECONNREFUSED') || String(args[0]).includes('ENOTFOUND'))) {
        fell_back = true;
        console.log('[stream] Ollama unreachable — falling back to Claude');
        if (!event.sender.isDestroyed()) {
          event.sender.send('stream-token', '*(Ollama offline — switching to Claude)*\n\n');
          event.sender.send('provider-status', { ollama: false });
        }
        // Restart Ollama in background for next message
        ensureOllama();
        streamAnthropicAgentic(event, messages, enrichedPrompt, claudeKey, elKey, voiceId);
        return;
      }
      if (!event.sender.isDestroyed()) originalSend(channel, ...args);
    };
    // Proxy event.sender.send for error interception
    const proxiedEvent = { sender: { send: fallbackOnError, isDestroyed: () => event.sender.isDestroyed() } };
    // Cortex_L fires when language generation begins (local model)
    fireBrain('Cortex_L', 0.95);
    fireBrain('Cortex_R', 0.5);  // creativity co-fires at lower intensity
    streamOpenAI(proxiedEvent, messages, enrichedPrompt, pc.baseUrl, pc.apiKey, pc.model, elKey, voiceId);
  } else {
    if (!claudeKey) { event.sender.send('stream-error', 'No Anthropic key'); return; }
    // Cortex_L fires for cloud language too, brighter — more complex reasoning
    fireBrain('Cortex_L', 1.0);
    fireBrain('Cortex_R', 0.7);
    streamAnthropicAgentic(event, messages, enrichedPrompt, claudeKey, elKey, voiceId);
  }
});

// ElevenLabs TTS — kept for non-streaming use
ipcMain.handle('tts-speak', (_, text, voiceId) => {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const apiKey = process.env.ELEVENLABS_API_KEY || cfg?.keys?.elevenlabs || '';
    if (!apiKey || !voiceId) return resolve(null);
    const body = JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } });
    const req = https.request({
      hostname: 'api.elevenlabs.io', path: `/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
});

// Whisper STT — local, free, no API key needed
ipcMain.handle('transcribe-audio', (_, audioBase64) => {
  return new Promise((resolve) => {
    const os = require('os');
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxia-'));
    const webmPath  = path.join(tmpDir, 'input.webm');
    const wavPath   = path.join(tmpDir, 'input.wav');
    fs.writeFileSync(webmPath, Buffer.from(audioBase64, 'base64'));

    const whisperBin = '/var/home/kvoldnes/.local/bin/whisper';
    const whisperEnv = { ...process.env, PATH: '/var/home/kvoldnes/.local/bin:/usr/bin:/bin:' + (process.env.PATH || '') };

    function runWhisper(audioFile, outStem) {
      return new Promise((res) => {
        const proc = spawn(whisperBin, [
          audioFile, '--model', 'tiny', '--output_format', 'txt',
          '--output_dir', tmpDir, '--language', 'en', '--fp16', 'False',
          '--condition_on_previous_text', 'False', '--temperature', '0'
        ], { env: whisperEnv });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        const timer = setTimeout(() => { proc.kill(); res({ ok: false, err: 'timeout' }); }, 30000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          const txtPath = path.join(tmpDir, outStem + '.txt');
          if (fs.existsSync(txtPath)) {
            res({ ok: true, text: fs.readFileSync(txtPath, 'utf8').trim() });
          } else {
            res({ ok: false, err: stderr || `exit ${code}` });
          }
        });
        proc.on('error', (e) => { clearTimeout(timer); res({ ok: false, err: e.message }); });
      });
    }

    async function run() {
      // Convert webm→wav first (whisper CLI can't handle webm reliably)
      await new Promise(res => {
        const ff = spawn('ffmpeg', ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', wavPath], { env: whisperEnv });
        ff.on('close', res); ff.on('error', res);
      });
      const audioFile = fs.existsSync(wavPath) ? wavPath : webmPath;
      const result = await runWhisper(audioFile, 'input');
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
      resolve(result.ok && result.text ? result.text : null);
    }
    run();
  });
});

// Companion state relay (chat → companion window)
ipcMain.handle('set-companion-state', (_, state) => {
  if (mainWindow) mainWindow.webContents.send('companion-state', state);
});

// Personality IPC
ipcMain.handle('get-personality', () => loadPersonality());
ipcMain.handle('save-personality', (_, data) => {
  savePersonality(data);
  const prompt = buildSystemPrompt(data, loadUserProfile(), mind.getContextString(), mind.getUnderstanding(), loadSelf());
  if (chatWindow) chatWindow.webContents.send('system-prompt-updated', prompt);
  if (mainWindow && data.appearance) mainWindow.webContents.send('appearance-updated', data.appearance);
  return true;
});
ipcMain.handle('get-system-prompt', () => buildSystemPrompt(loadPersonality(), loadUserProfile(), mind.getContextString(), mind.getUnderstanding(), loadSelf()));

// User profile — persistent memory of who the human is
ipcMain.handle('load-user-profile', () => loadUserProfile());
ipcMain.handle('load-self-data',    () => loadSelf());
ipcMain.handle('get-self-model',    () => selfModel);
ipcMain.handle('get-thought-bank',  () => getThoughtBank());
ipcMain.handle('write-feedback',    async (_, { query, response, correction }) => {
  try { await lanceMemory.writeFeedback(query, response, correction); return true; }
  catch(e) { console.error('[feedback] write error:', e.message); return false; }
});
ipcMain.handle('save-user-profile', (_, data) => saveUserProfile(data));

// Background extraction: runs Haiku over recent messages to pull facts about the user
ipcMain.handle('extract-profile', (_, recentMessages) => {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const apiKey = process.env.ANTHROPIC_API_KEY || cfg?.keys?.anthropic || '';
    if (!apiKey) return resolve(null);

    const existing = loadUserProfile();
    const convo = recentMessages.slice(-20)
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : (m.content[0]?.text || '')}`)
      .join('\n');

    const extractPrompt = `Analyze this conversation and extract facts about the USER (not the assistant).

Already known facts: ${JSON.stringify(existing.facts)}
Already known interests: ${JSON.stringify(existing.interests)}
Known name: ${existing.userName || 'unknown'}

Conversation:
${convo}

Return ONLY valid JSON, no markdown fences:
{
  "userName": "first name if clearly mentioned, else null",
  "newFacts": ["specific new fact about the user not already in known facts"],
  "newInterests": ["new topic/interest the user mentioned, not already known"],
  "removeFacts": ["any known fact that was contradicted or is now wrong"]
}

Only include facts that are clearly stated. Keep each fact short (under 10 words). If nothing new, return empty arrays.`;

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      messages: [{ role: 'user', content: extractPrompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          const raw = p.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
          const extracted = JSON.parse(raw);
          const updated = { ...existing };
          if (extracted.userName && !updated.userName) updated.userName = extracted.userName;
          if (extracted.newFacts?.length)
            updated.facts = [...new Set([...updated.facts, ...extracted.newFacts])].slice(0, 30);
          if (extracted.newInterests?.length)
            updated.interests = [...new Set([...updated.interests, ...extracted.newInterests])].slice(0, 20);
          if (extracted.removeFacts?.length)
            updated.facts = updated.facts.filter(f => !extracted.removeFacts.includes(f));
          updated.lastSeen = new Date().toISOString().split('T')[0];
          saveUserProfile(updated);
          resolve(updated);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
});

ipcMain.handle('get-model-rotation', () => {
  const cfg = loadConfig() || {};
  return cfg.modelRotation ?? 0;
});
ipcMain.handle('set-model-rotation', (_, value) => {
  const cfg = loadConfig() || {};
  cfg.modelRotation = value;
  saveConfig(cfg);
  if (mainWindow) mainWindow.webContents.send('model-rotation', value);
});

// Mind awareness — next thought from the batch (context-enriched)
ipcMain.handle('mind-next-thought', () => mind.nextThought());

// Screen context — query Screenpipe OCR for recent on-screen text
ipcMain.handle('screenshot', async () => {
  fireBrain('Cortex_R', 0.9);
  fireBrain('Mirror', 0.6);
  const description = await mind.describeScreen();
  if (description) fireBrain('Hippocampus', 0.5);
  return { b64: null, description };
});

// Avatar emotion bridge — chat.html → main → companion window
// Also updates mood state and pushes to brain visualisation
const EMOTION_TO_MOOD = {
  happy:     { attachment: 0.7, curiosity: 0.5, motor: 0.6, creativity: 0.6 },
  sad:       { attachment: 0.8, fear: 0.2, tiredness: 0.4, memory_load: 0.5 },
  curious:   { curiosity: 0.9, reasoning: 0.6, creativity: 0.5 },
  thinking:  { reasoning: 0.8, memory_load: 0.6, creativity: 0.4 },
  excited:   { curiosity: 0.8, attachment: 0.6, motor: 0.8, creativity: 0.7 },
  neutral:   { curiosity: 0.3, attachment: 0.3, reasoning: 0.3 },
  concerned: { fear: 0.4, attachment: 0.6, memory_load: 0.4 },
  playful:   { curiosity: 0.7, motor: 0.7, creativity: 0.8, attachment: 0.5 },
};

let moodState = {
  curiosity: 0.5, attachment: 0.3, tiredness: 0.0,
  reasoning: 0.2, memory_load: 0.1, fear: 0.0,
  motor: 0.3, heartbeat: 1.0, empathy: 0.3,
  language: 0.5, creativity: 0.4,
};

// Lightweight nudge — used by mind events (no disk write, no broadcast)
function nudgeMood(deltas) {
  for (const [k, v] of Object.entries(deltas)) {
    if (moodState[k] !== undefined) moodState[k] = Math.min(1, moodState[k] * 0.8 + v * 0.2);
  }
}

function updateMoodFromEmotion(emotion) {
  const delta = EMOTION_TO_MOOD[emotion] || EMOTION_TO_MOOD.neutral;
  for (const [k, v] of Object.entries(delta)) {
    moodState[k] = moodState[k] * 0.6 + v * 0.4; // smooth drift
  }
  // Tiredness slowly creeps up
  moodState.tiredness = Math.min(1.0, moodState.tiredness + 0.01);
  // Save to disk for persistence
  try {
    const { app } = require('electron');
    const p = require('path').join(app.getPath('userData'), 'nyxia-mood.json');
    require('fs').writeFileSync(p, JSON.stringify(moodState, null, 2));
  } catch (_) {}
  // Broadcast to companion window brain
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mood-update', moodState);
  }
}

ipcMain.handle('avatar-react', (_, data) => {
  if (data.emotion && data.emotion !== 'thinking') updateMoodFromEmotion(data.emotion);
  if (data.reply) {
    const { analyzeEmotion } = require('./avatar-brain');
    const result = analyzeEmotion(data.reply);
    data.emotion = result.emotion; // companion window animates to detected emotion
    if (result.emotion !== 'idle') updateMoodFromEmotion(result.emotion);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('avatar-react', data);
});

// Curiosity batch — generates 6-8 personalized idle thoughts/questions using Haiku
ipcMain.handle('generate-curiosity-batch', (_, profile, timeCtx) => {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const apiKey = process.env.ANTHROPIC_API_KEY || cfg?.keys?.anthropic || '';
    if (!apiKey) return resolve([]);

    const nameLine = profile.userName ? `Their name is ${profile.userName}.` : '';
    const factsLine = profile.facts?.length ? `Known facts: ${profile.facts.slice(0, 5).join('; ')}.` : '';
    const interestsLine = profile.interests?.length ? `Interests: ${profile.interests.slice(0, 5).join(', ')}.` : '';
    const sessions = profile.sessionCount || 0;

    const prompt = `You are Nyxia — a darkly playful, genuinely curious AI companion living on someone's desktop. It is ${timeCtx}. ${nameLine} ${factsLine} ${interestsLine} Sessions together: ${sessions}.

Generate 6 short curiosity thoughts/questions Nyxia would show spontaneously in a speech bubble while the person is idle. Mix these types:
- A genuine curious question about what they might be working on or thinking about
- A whimsical "I've been wondering..." thought
- Something connected to their known interests (if any), or general if none
- A playful observation about time of day, existence, or whatever feels natural

Rules:
- Each is 1-2 sentences max — short, punchy
- Sound like Nyxia: dark elegance, wit, genuine warmth underneath
- Use ✦ or ~ in some but not all
- Do NOT say "how can I help" or be generic-assistant-y
- Vary the mood: curious, wistful, playful, sharp

Return ONLY a JSON array of 6 strings, no markdown fences:
["thought1", "thought2", "thought3", "thought4", "thought5", "thought6"]`;

    const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          const raw = p.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
          const arr = JSON.parse(raw);
          resolve(Array.isArray(arr) ? arr : []);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body); req.end();
  });
});

// Nyxia-initiated topic — opens chat and seeds Nyxia's opening message
ipcMain.handle('nyxia-initiate-topic', (_, topic) => {
  if (!chatWindow) return;
  const wasVisible = chatWindow.isVisible();
  if (!wasVisible) {
    chatWindow.show();
    chatWindow.focus();
    const [x, y] = chatWindow.getPosition();
    const [w, h] = chatWindow.getSize();
    if (mainWindow) mainWindow.webContents.send('chat-bounds', { x, y, width: w, height: h });
  }
  // Delay slightly so chat is rendered before we inject the message
  setTimeout(() => {
    if (!chatWindow.isDestroyed()) chatWindow.webContents.send('nyxia-topic', topic);
  }, wasVisible ? 50 : 350);
});

// ── Terminal (node-pty) ────────────────────────────────────────────────────────
const ptyProcs = new Map(); // windowId → pty process

ipcMain.on('pty-start', (event, { cols, rows }) => {
  const wid = event.sender.id;
  if (ptyProcs.has(wid)) { ptyProcs.get(wid).kill(); ptyProcs.delete(wid); }
  const shell = process.env.SHELL || '/bin/bash';
  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80, rows: rows || 24,
    cwd: process.env.HOME || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' }
  });
  ptyProcs.set(wid, proc);
  proc.onData(data => { if (!event.sender.isDestroyed()) event.sender.send('pty-data', data); });
  proc.onExit(() => { ptyProcs.delete(wid); if (!event.sender.isDestroyed()) event.sender.send('pty-exit'); });
});

ipcMain.on('pty-input', (event, data) => {
  const proc = ptyProcs.get(event.sender.id);
  if (proc) proc.write(data);
});

ipcMain.on('pty-resize', (event, { cols, rows }) => {
  const proc = ptyProcs.get(event.sender.id);
  if (proc) proc.resize(cols, rows);
});

ipcMain.on('pty-kill', (event) => {
  const proc = ptyProcs.get(event.sender.id);
  if (proc) { proc.kill(); ptyProcs.delete(event.sender.id); }
});

// Kill all PTYs on exit
app.on('will-quit', () => { for (const [, p] of ptyProcs) try { p.kill(); } catch(_) {} });

// ── Hot reload — watch renderer files ─────────────────────────────────────────
app.whenReady().then(() => {
  const watcher = chokidar.watch(path.join(__dirname, '*.html'), { ignoreInitial: true });

  watcher.on('change', changedPath => {
    const file = path.basename(changedPath);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (file === 'combined.html') {
      mainWindow.reload();
    } else if (file === 'chat.html' || file === 'index.html') {
      // Reload the specific webview via IPC
      mainWindow.webContents.send('hot-reload', file);
    }
  });
});
