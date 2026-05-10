const { app, BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const chokidar = require('chokidar');
const logger = require('./utils/logger');
const mind        = require('./mind');
const { fireSector, getSelfBelief, migrateFromSelfJson, setMainWindow } = require('./brain-soul');
const lanceMemory = require('./lance-memory');
const graphMemory = require('./graph-memory');
const { startAwarenessLoop, getThoughtBank, notifyUserMessage, seedConcept, notifyPresence, getPendingReturns } = require('./awareness-loop');
const { startInteroception, getBodyState }                                   = require('./interoception');
const { startOtherModel, notifyConversationTurn, getOtherModelContext, getKristianState } = require('./other-model');
const { startCuriosityEngine, detectGapsFromConversation, getGaps, resolveGap, tryResolveGap, addGap } = require('./curiosity-gaps');
const predictedReality  = require('./predicted-reality');
const actionTracker     = require('./action-tracker');
const environmentState  = require('./environment-state');
const { startSleepCycle, getMorningThought, getNarrativeArc, notifyActivity } = require('./sleep-cycle');
const { browserExecute, closeBrowser, setViewId, browserLoad } = require('./browser');
const { desktopExecute } = require('./desktop');
const { executeShell, formatResult } = require('./shell');
const { runAgentLoop, runCodingLoop } = require('./agent-loop');
const { NYXIA_TOOLS, runTool } = require('./nyxia-tools');
const { startApiServer, stopApiServer, broadcastSSE } = require('./api-server');
const { queryOllama, parseJsonObject } = require('./utils/ollama-client');
const ollamaScheduler = require('./utils/ollama-scheduler');
const contextLayer      = require('./context-layer');
const sharedExperience  = require('./shared-experience');
const { loadConfig, saveConfig, loadPersonality, savePersonality, loadSelf, saveSelf, loadUserProfile, saveUserProfile, getPrivacy, appendAudit } = require('./config-manager');
const { ensureChroma, ensureOllama, waitForVram, killChroma, killOllama, isOllamaSpawned } = require('./service-startup');
const { SEARXNG_URL, querySearch, extractUrl, fetchPage, fsResolvePath, fsSanitize, fsListDir, fsReadFile, fsWriteFile } = require('./tools');
const { splitSseLines, flushTtsSentence, finishStream } = require('./ipc/streaming');
const { startClaudeWatcher } = require('./claude-watcher');
const krixMemory = require('./krix-memory');
const llmAdapter = require('./llm/adapter');

app.setName('Nyxia');
if (process.platform === 'linux') {
  app.setDesktopName('nyxia-companion');
  app.commandLine.appendSwitch('enable-features', 'WebSpeechRecognition,WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // NVIDIA proprietary driver on Linux requires disabling GPU sandbox
  // Without this, Electron's GPU process crashes silently → black canvas
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('enable-webgl');
}

let mainWindow;
let chatWindow;
let desktopWindow;
let pythonBackend;

// Avatar emotion bridge — chat.html → main → companion window
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

const { createCompanionWindow, createChatWindow, createCombinedWindow, createDesktopWindow, getDesktopPresets } = require('./window-manager')({
  setMain:    w => { mainWindow  = w; },
  setChat:    w => { chatWindow  = w; },
  setDesktop: w => { desktopWindow = w; },
  getMain:    () => mainWindow,
  getDesktop: () => desktopWindow,
  loadConfig, saveConfig,
  __dirname,
});

const memoryPath    = path.join(app.getPath('userData'), 'nyxia-memory.json');
const selfModelPath = path.join(app.getPath('userData'), 'nyxia-selfmodel.json');

// Reflections now live in LanceDB — no cap. Cache refreshed after each write.
let _lanceReflections    = [];
let _graphContext        = null; // Kùzu graph connections, refreshed alongside LanceDB
let _screenInterpretation = null; // qwen2.5vl:7b interpretation of current screen OCR
let _krixContext         = ''; // KRIX-BRAIN world context snippets, refreshed per turn
let krixApiProc          = null;
let brainCoreProc        = null;

// Mem0-style learned facts — extracted from conversations, persisted across sessions
let _learnedFacts = [];
function _factsPath() { return path.join(require('electron').app.getPath('userData'), 'nyxia-facts.json'); }
function _loadFacts() {
  try { _learnedFacts = JSON.parse(fs.readFileSync(_factsPath(), 'utf8')); } catch(_) { _learnedFacts = []; }
}
function _saveFacts() {
  try { fs.writeFileSync(_factsPath(), JSON.stringify(_learnedFacts, null, 2)); } catch(_) {}
}

// Extract facts from a single exchange — fire-and-forget, called after stream-done
async function extractFactsAsync(userMsg, assistantMsg) {
  if (!userMsg || userMsg.length < 20 || !assistantMsg || assistantMsg.length < 10) return;
  try {
    const cfg = loadConfig();
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.mindModel || 'qwen3:8b',
        messages: [{
          role: 'system',
          content:
            'Extract 1-3 short factual statements about the USER from this conversation exchange. ' +
            'Only extract concrete, reusable facts: preferences, projects, skills, life details, opinions. ' +
            'Skip small talk and questions. If nothing factual is present, output an empty array. ' +
            'Output JSON array of strings only. Example: ["User is learning Rust", "User prefers dark themes"]'
        }, {
          role: 'user',
          content: `User: ${userMsg.slice(0, 400)}\nAssistant: ${assistantMsg.slice(0, 400)}`
        }],
        stream: false,
        format: { type: 'array', items: { type: 'string' } },
        options: { temperature: 0, num_predict: 80 }
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return;
    const data = await res.json();
    let facts = [];
    try { facts = JSON.parse(data.message?.content || '[]'); } catch(_) { return; }
    if (!Array.isArray(facts) || facts.length === 0) return;

    // Deduplicate against existing facts (simple substring check)
    const newFacts = facts.filter(f =>
      typeof f === 'string' && f.length > 5 &&
      !_learnedFacts.some(e => e.toLowerCase().includes(f.toLowerCase().slice(0, 20)))
    );
    if (newFacts.length === 0) return;

    _learnedFacts = [..._learnedFacts, ...newFacts].slice(-50); // keep last 50
    _saveFacts();
    console.log('[facts] learned:', newFacts);
  } catch(e) {
    // silent — fact extraction is best-effort
  }
}

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
    // 14.14 — dynamic query: use top active concepts when available, fallback to identity
    const { getTopConcepts } = require('./awareness-loop');
    const topConcepts = getTopConcepts();
    const dynamicQuery = topConcepts.length > 0
      ? `${topConcepts.join(' ')} identity self nyxia`
      : 'identity self beliefs nyxia growth experience';
    _lanceReflections = await lanceMemory.queryRelevant(ctx || dynamicQuery, 8);
    mind.setReflectionContext(_lanceReflections);
    // Refresh graph context from top LanceDB result
    if (_lanceReflections.length > 0) {
      _graphContext = await graphMemory.queryMemoryGraph(_lanceReflections[0]);
    }
    // Refresh KRIX-BRAIN world context in parallel (fire and forget)
    refreshKrixContext(ctx || dynamicQuery).catch(() => {});
  } catch (e) { _lanceReflections = []; }
}

// Self-model — Nyxia's live present-moment awareness (Phase 8)
let selfModel = {
  what_im_doing: '', how_im_feeling: '', what_i_want_right_now: '',
  current_attention: '', pending_concern: '', inner_tension: 0.0, last_updated: ''
};

// Load learned facts at boot
_loadFacts();

// Load startup memory once at boot — canonical source is KRIX-BRAIN, fallback to local docs/
let _startupMemory = '';
try {
  const krixSoulPath = '/var/home/kvoldnes/krix-brain/nyxia/soul/STARTUP_MEMORY.md';
  const localPath    = path.join(__dirname, '..', 'docs', 'STARTUP_MEMORY.md');
  const smPath = fs.existsSync(krixSoulPath) ? krixSoulPath : localPath;
  if (fs.existsSync(smPath)) _startupMemory = fs.readFileSync(smPath, 'utf8').trim();
} catch(e) {}


const buildSystemPrompt = require('./prompt-builder')({
  getStartupMemory:        () => _startupMemory,
  getSelfModel:            () => selfModel,
  getMoodState:            () => moodState,
  getLanceReflections:     () => _lanceReflections,
  getCortexBeliefs:        () => _cortexBeliefs,
  getGraphContext:         () => _graphContext,
  getScreenInterpretation: () => _screenInterpretation,
  getLearnedFacts:         () => _learnedFacts,
  getKrixBrainContext:     () => _krixContext,
});


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
let brainPanelWindow = null;
let sphereWindow     = null;

function fireBrain(sector, intensity = 1.0, decay = 0.85, label) {
  const payload = { sector, intensity, decay, label };
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('brain-fire', payload);
  if (brainPanelWindow && !brainPanelWindow.isDestroyed())
    brainPanelWindow.webContents.send('brain-fire', payload);
}

function openBrainPanel() {
  if (brainPanelWindow && !brainPanelWindow.isDestroyed()) {
    brainPanelWindow.focus();
    return;
  }
  brainPanelWindow = new BrowserWindow({
    width: 700, height: 700,
    title: 'Nyxia — Neural Activity',
    backgroundColor: '#000000',
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  brainPanelWindow.loadFile(path.join(__dirname, 'brain-panel.html'));
  brainPanelWindow.on('closed', () => { brainPanelWindow = null; });
}

function openSphereWindow() {
  if (sphereWindow && !sphereWindow.isDestroyed()) { sphereWindow.focus(); return; }
  sphereWindow = new BrowserWindow({
    width: 900, height: 900,
    title: 'Nyxia — Neural Sphere',
    backgroundColor: '#000008',
    frame: false,
    resizable: true,
    alwaysOnTop: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  sphereWindow.loadURL('http://127.0.0.1:12345/viz/graphify-out/sphere.html');
  sphereWindow.on('closed', () => { sphereWindow = null; });
}

// ── KRIX-BRAIN API ────────────────────────────────────────────────────────────
function ensureKrixApi() {
  if (krixApiProc) return;
  const apiPath = '/var/home/kvoldnes/krix-brain/mcp/api.py';
  if (!fs.existsSync(apiPath)) return;
  krixApiProc = spawn('python3', [apiPath], { detached: false, stdio: 'pipe' });
  krixApiProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.log('[krix-api]', msg);
  });
  krixApiProc.on('error', e => console.warn('[krix-api] spawn error:', e.message));
  krixApiProc.on('exit', () => { krixApiProc = null; });
}

function ensureBrainCore() {
  if (brainCoreProc) return;
  const brainDir = '/var/home/kvoldnes/krix-brain';
  const agentApi = require('path').join(brainDir, 'brain_core', 'agent_api.py');
  if (!require('fs').existsSync(agentApi)) return;
  brainCoreProc = spawn('python3', ['-m', 'brain_core.agent_api'], {
    cwd: brainDir, detached: false, stdio: 'pipe',
    env: { ...process.env, PYTHONPATH: brainDir },
  });
  brainCoreProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.log('[brain-core]', msg);
  });
  brainCoreProc.on('error', e => console.warn('[brain-core] spawn error:', e.message));
  brainCoreProc.on('exit', () => { brainCoreProc = null; });
}

async function refreshKrixContext(conversationTopic = '') {
  try {
    const query = conversationTopic || 'Kristian projects current work life';
    const results = await krixMemory.searchBrain(query, { top_k: 4 });
    if (results.length === 0) { _krixContext = ''; return; }
    _krixContext = results.map(r => r.snippet.trim()).filter(Boolean).join('\n\n');
  } catch { _krixContext = ''; }
}

// ── Service startup (ensureChroma/ensureOllama/ensureFlux/waitForVram) ────────
// Extracted to src/service-startup.js

// ── TTS servers ───────────────────────────────────────────────────────────────
const QWEN3_PORT      = 8884;                                // Qwen3-TTS — primary when GPU present
const KOKORO_PORT     = 8883;                                // Kokoro — primary (fastest, CPU)
const CHATTERBOX_PORT = 8881;                                // XTTS v2 — fallback (voice clone)
const QWEN3_BIN       = '/var/home/kvoldnes/qwen3-tts-env/bin/python';
const QWEN3_SRV       = '/var/home/kvoldnes/claude-projects/nyxia/qwen3_tts_server.py';
const KOKORO_BIN      = '/var/home/kvoldnes/xtts-env/bin/python';
const KOKORO_SRV      = '/var/home/kvoldnes/nyxia/kokoro_server.py';
const CHATTERBOX_BIN  = '/var/home/kvoldnes/xtts-env/bin/python';
const CHATTERBOX_SRV  = '/var/home/kvoldnes/nyxia/xtts_server.py';
let qwen3Proc = null;
let kokoroProc = null;
let chatterboxProc = null;
let chatterboxStatus = { ready: false, label: '—' };

// ── Wake word ─────────────────────────────────────────────────────────────────
const WAKE_WORD_BIN = process.execPath.includes('electron')
  ? '/usr/bin/python3'
  : 'python3';
const WAKE_WORD_SRV    = path.join(__dirname, '..', 'wake_word.py');
const WEBCAM_PRES_SRV  = path.join(__dirname, '..', 'webcam_presence.py');
let wakeWordProc = null;
let webcamPresProc = null;

function startWakeWord() {
  if (wakeWordProc) return;
  if (!require('fs').existsSync(WAKE_WORD_SRV)) {
    console.warn('[wake-word] wake_word.py not found — skipping');
    return;
  }
  wakeWordProc = spawn(WAKE_WORD_BIN, [WAKE_WORD_SRV], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  wakeWordProc.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.trim() === 'WAKE') {
        console.log('[wake-word] detected — activating mic');
        sharedExperience.logEvent('wake-word', 'Kristian called out — initiated voice contact', 0.3);
        fireBrain('mirror', 0.9, 0.88, 'listening');
        fireBrain('stem',   0.7, 0.9,  'wake-word');
        if (chatWindow && !chatWindow.isDestroyed())
          chatWindow.webContents.send('wake-word-detected');
      }
    }
  });
  wakeWordProc.stderr.on('data', d => console.log('[wake-word]', d.toString().trim()));
  wakeWordProc.on('error', e => console.warn('[wake-word] spawn error:', e.message));
  wakeWordProc.on('exit', c => { console.log('[wake-word] exited:', c); wakeWordProc = null; });
  console.log('[wake-word] listener started');
}

function startWebcamPresence() {
  if (webcamPresProc) return;
  if (!require('fs').existsSync(WEBCAM_PRES_SRV)) {
    console.warn('[webcam-presence] webcam_presence.py not found — skipping');
    return;
  }
  webcamPresProc = spawn(WAKE_WORD_BIN, [WEBCAM_PRES_SRV], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  webcamPresProc.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const ev = line.trim();
      if (ev === 'PRESENT' || ev === 'ABSENT') {
        const present = ev === 'PRESENT';
        console.log(`[webcam-presence] ${ev}`);
        contextLayer.setContext('scene', { userPresent: present, ts: Date.now() });
        sharedExperience.logEvent(
          present ? 'user-arrived' : 'user-left',
          present ? 'Kristian appeared on camera' : 'Kristian left the camera frame',
          present ? 0.2 : -0.1
        );
        if (chatWindow && !chatWindow.isDestroyed())
          chatWindow.webContents.send('webcam-presence', { present });

        // Notify awareness loop of presence change
        notifyPresence(present);

        // Return detection — surface queued thoughts + warm greeting
        if (present && _webcamAbsentSince) {
          const absentMs  = Date.now() - _webcamAbsentSince;
          const absentMin = Math.round(absentMs / 60000);
          _webcamAbsentSince = null;

          if (absentMs > 10 * 60 * 1000) {
            // Surface thoughts accumulated during absence, staggered
            const pending = getPendingReturns();
            if (pending.length > 0) {
              // First thought after a short delay — feels natural, not dumped
              pending.slice(0, 3).forEach((p, i) => {
                setTimeout(() => proactiveSpeak('thought', p.text), (i + 1) * 18000);
              });
              console.log(`[presence] return after ${absentMin}min — surfacing ${pending.length} queued thought(s)`);
            } else {
              proactiveSpeak('thought', `He stepped away for ${absentMin} minutes. He's back now.`);
            }
          }
        } else if (!present) {
          _webcamAbsentSince = Date.now();
        }
      }
    }
  });
  webcamPresProc.stderr.on('data', d => console.log('[webcam-presence]', d.toString().trim()));
  webcamPresProc.on('error', e => console.warn('[webcam-presence] spawn error:', e.message));
  webcamPresProc.on('exit', c => { console.log('[webcam-presence] exited:', c); webcamPresProc = null; });
  console.log('[webcam-presence] started');
}

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


async function ensureQwen3() {
  try {
    const r = await fetch(`http://127.0.0.1:${QWEN3_PORT}/health`);
    if (r.ok) { console.log('[qwen3-tts] already running'); return; }
  } catch (_) {}

  if (!require('fs').existsSync(QWEN3_BIN)) {
    console.warn('[qwen3-tts] python binary not found:', QWEN3_BIN);
    return;
  }

  // Wait for enough VRAM before spawning (game may still be releasing GPU memory)
  await waitForVram(5500, 30000);

  console.log('[qwen3-tts] starting...');
  qwen3Proc = spawn(QWEN3_BIN, [QWEN3_SRV], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: process.env.HOME || '/var/home/kvoldnes' },
  });
  qwen3Proc.stdout.on('data', d => console.log('[qwen3-tts]', d.toString().trim()));
  qwen3Proc.stderr.on('data', d => console.log('[qwen3-tts]', d.toString().trim()));
  qwen3Proc.on('error', e => console.error('[qwen3-tts] spawn error:', e.message));
  qwen3Proc.on('exit',  c => { console.log('[qwen3-tts] exited:', c); qwen3Proc = null; });

  // Wait up to 120s for model load (GPU warmup)
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
// Screenpipe removed — vision now handled internally via desktopCapturer + qwen2.5vl:7b (see mind.js)

// ── SearXNG — private web search (Phase 4.1) ────────────────────────────────
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

// Web/FS tools extracted to src/tools.js

// ── Proactive curiosity / observation engine ─────────────────────────────────
// Nyxia speaks unprompted when she notices something interesting.
// Cooldown prevents spam; probability varies by trigger type.
let _lastProactiveSpeak = 0;
let _sessionTurns = []; // last N exchanges for anchor extraction
let _sessionStartTime = Date.now();
let _sessionArcFired = { h90: false, h3: false };
let _webcamAbsentSince = null; // timestamp when user left camera
let _lastMoodLog = 0; // throttle mood log writes
const PROACTIVE_COOLDOWN_MS = 90 * 1000; // 90s between unprompted utterances

// Extract a memorable anchor sentence from recent exchanges, store in LanceDB
async function _extractAnchorAsync(turns) {
  if (!turns || turns.length < 2) return;
  const transcript = turns.map(t => `Kristian: ${t.user.slice(0, 120)}\nNyxia: ${t.nyxia.slice(0, 120)}`).join('\n');
  const prompt = `From this conversation, extract ONE sentence that feels most significant — a decision, confession, goal, or genuine moment. Just the sentence itself, nothing else.\n\n${transcript}`;
  const model  = loadConfig()?.keys?.chatModel || 'nyxia-dolphin';
  const anchor = await ollamaScheduler.enqueue(3, () =>
    queryOllama('', prompt, { model, maxTokens: 60, timeoutMs: 10000 }), 'anchor-extract'
  ).catch(() => null);
  if (anchor && anchor.length > 10) {
    await lanceMemory.writeAnchor(anchor.trim());
  }
}

async function proactiveSpeak(trigger, context) {
  const now = Date.now();
  if (now - _lastProactiveSpeak < PROACTIVE_COOLDOWN_MS) return;
  if (!chatWindow || chatWindow.isDestroyed()) return;

  const cfg      = loadConfig();

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

    heartbeat: `You are Nyxia. ${nameLine} ${selfLine}
Something just surfaced in your awareness: "${context}".
Speak one spontaneous thought aloud — raw and alive. Not a report. Just what's rising in you right now.
1-2 sentences max. No preamble. Just speak.`,

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
    mind.injectEvent({ type: 'self-thought', summary: `I thought aloud: "${context.slice(0, 80)}"` });
    return;
  }

  const prompt = prompts[trigger];
  if (!prompt) return;

  _lastProactiveSpeak = now; // mark before async to prevent race

  const model = cfg?.keys?.chatModel || 'nyxia-dolphin';
  const text = await ollamaScheduler.enqueue(2, () =>
    queryOllama('', prompt, { model, maxTokens: 120, timeoutMs: 14000 }), 'proactive'
  ).catch(() => null);

  if (text && text.length > 5) {
    fireBrain('Cortex_L', 0.9);   // speaking
    fireBrain('Amygdala_R', 0.7); // curiosity driving it
    fireBrain('Mirror', 0.5);     // awareness of the world
    if (!chatWindow.isDestroyed())
      chatWindow.webContents.send('nyxia-proactive', { text, trigger });
    mind.injectEvent({ type: 'self-spoke', summary: `I said (${trigger}): "${text.slice(0, 80)}"` });
  }
}

// ── Heartbeat loop — sensory delta + interrupt scoring ───────────────────────
// Every 45s: check what changed, ask llama3.2:3b whether to interrupt (0-1).
// Phase 1.4: logs score only. Actual interrupts wired in Phase 2 (dualDebate).

let _lastHeartbeatInterrupt = 0;
const HEARTBEAT_COOLDOWN_MS = 90 * 1000; // min 90s between heartbeat interrupts

function canHeartbeatInterrupt() {
  return Date.now() - _lastHeartbeatInterrupt > HEARTBEAT_COOLDOWN_MS;
}

// Lightweight Ollama call — returns raw text, no streaming, short timeout
async function _heartbeatQuery(prompt) {
  return (await ollamaScheduler.enqueue(1, () => queryOllama('', prompt, { maxTokens: 10, timeoutMs: 6000 }), 'heartbeat')) || '0';
}

// Short Ollama call for edge labeling — injected into writeReflection as callOllama
async function _callMindModel(prompt) {
  const model = loadConfig()?.mindModel || 'qwen3:8b';
  return (await ollamaScheduler.enqueue(3, () => queryOllama('', prompt, { model, maxTokens: 30, timeoutMs: 8000 }), 'edge-label')) || '';
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

      if (score >= 0.50 && canHeartbeatInterrupt()) {
        _lastHeartbeatInterrupt = Date.now();
        proactiveSpeak('heartbeat', delta.summary);
      }
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

    const parsed = parseJsonObject(
      await ollamaScheduler.enqueue(2, () => queryOllama(sysPrompt, userMsg, { maxTokens: 200, timeoutMs: 8000 }), 'self-model')
    );

    if (parsed) {
      // Flatten any nested objects to strings (LLM sometimes returns objects for string fields)
      for (const k of ['what_im_doing','how_im_feeling','what_i_want_right_now','current_attention','pending_concern']) {
        if (parsed[k] && typeof parsed[k] === 'object') {
          const entries = Object.entries(parsed[k]);
          if (entries.every(([,v]) => typeof v === 'number')) {
            // Numeric mood object — take key with highest value
            parsed[k] = entries.sort((a,b) => b[1]-a[1]).map(([k]) => k).slice(0,2).join(', ');
          } else {
            parsed[k] = entries.map(([,v]) => v).filter(v => typeof v === 'string').join(', ') || String(entries[0]?.[1] || '—');
          }
        }
      }
      Object.assign(selfModel, parsed);
      selfModel.inner_tension = Math.min(1, Math.max(0, parseFloat(selfModel.inner_tension) || 0));
      selfModel.last_updated  = new Date().toISOString();
      try { fs.writeFileSync(selfModelPath, JSON.stringify(selfModel, null, 2)); } catch(_) {}
      console.log(`[self-model] updated — doing="${selfModel.what_im_doing}" tension=${selfModel.inner_tension.toFixed(2)}`);
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
    moodState.tiredness = 0; // reset tiredness each session — rest has happened
  } catch(_) {}

  // Passive mood decay — all values drift toward neutral every 2min
  const MOOD_NEUTRAL = { curiosity: 0.3, attachment: 0.3, tiredness: 0.0, reasoning: 0.2,
    memory_load: 0.1, fear: 0.0, motor: 0.3, heartbeat: 1.0, empathy: 0.3, language: 0.4, creativity: 0.4 };
  setInterval(() => {
    for (const [k, target] of Object.entries(MOOD_NEUTRAL)) {
      if (k === 'heartbeat') continue;
      if (moodState[k] !== undefined) moodState[k] = moodState[k] * 0.97 + target * 0.03;
    }
  }, 2 * 60 * 1000);

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
  ensureChroma(() => app.getPath('userData'));

  // Start KRIX-BRAIN API server (unified memory substrate)
  ensureKrixApi();
  // Start brain-core neural layer (ports 7422 + 7423: agent API + spike bus)
  ensureBrainCore();

  // 14.12 — Purge refusal messages from LanceDB (one-time cleanup of March 2026 pollution)
  setTimeout(async () => {
    await lanceMemory.purgeBySnippets(["I can't write this", "I can't do this", "I won't generate",
      "I need to stop here", "I need to pause here", "I appreciate you laying", "I appreciate your directness",
      "I need to decline", "I'm not going to generate"]);
  }, 10000);

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
  createDesktopWindow();
  startPythonBackend();

  // Start Qwen3-TTS (GPU primary) — Kokoro/XTTS not auto-started (GPU available)
  ensureQwen3();
  // SearXNG — private web search
  ensureSearXNG();
  // API server — local HTTP endpoint for phone/PWA (Phase 5.1)
  startApiServer(12345, {
    loadConfig, loadPersonality, loadUserProfile, loadSelf,
    buildSystemPrompt, classifyMessage,
    querySearch, fetchPage, fsListDir, fsReadFile, fsWriteFile,
    extractUrl, fsResolvePath,
    getMoodState: () => moodState,
    onPhoneMessage: (userMsg, reply) => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send('phone-message', { userMsg, reply });
      }
    },
  });
  // Wake word — start after Ollama is up (60s delay)
  setTimeout(() => startWakeWord(), 60 * 1000);
  // Webcam presence — non-critical, start after 90s
  setTimeout(() => startWebcamPresence(), 90 * 1000);
  // Heartbeat — starts after 90s to let Ollama finish initialising
  setTimeout(() => startHeartbeat(), 90 * 1000);
  // Self-model loop — starts after 2min (Ollama must be warm first)
  setTimeout(() => updateSelfModel(), 120 * 1000);
  // Awareness loop — starts after 3min (after Ollama, Screenpipe, and self-model are warm)
  // Interoception — system metrics as felt body state (starts immediately)
  startInteroception({ seedConcept });

  // Claude Code session watcher — lights up brain sectors from tool calls
  startClaudeWatcher((sector, intensity) => fireBrain(sector, intensity, 0.85, 'claude'));

  // Session arc check-in — gentle nudge at 90min and 3hr marks
  setInterval(() => {
    if (_sessionTurns.length < 3) return; // no real session yet
    const _elapsed = (Date.now() - _sessionStartTime) / 3600000;
    if (!_sessionArcFired.h90 && _elapsed >= 1.5) {
      _sessionArcFired.h90 = true;
      proactiveSpeak('heartbeat', `We've been at this for 90 minutes. How's it going?`);
    } else if (!_sessionArcFired.h3 && _elapsed >= 3.0) {
      _sessionArcFired.h3 = true;
      proactiveSpeak('heartbeat', `Three hours. I wonder if your eyes need a rest.`);
    }
  }, 5 * 60 * 1000);

  // Other-model — theory of mind for Kristian (starts immediately)
  startOtherModel({ userData: app.getPath('userData'), getMindModel: () => loadConfig()?.mindModel || 'qwen3:8b' });

  // Curiosity engine — information-gap tracking (starts immediately)
  startCuriosityEngine({
    userData:    app.getPath('userData'),
    seedConcept,
    querySearch,
    onResolved: async (gap, answer) => {
      // Write resolved insight to LanceDB as a reflection
      if (lanceMemory) {
        await lanceMemory.writeReflection(`[curiosity-resolved] Q: "${gap.text}" → ${answer}`);
      }
      sharedExperience.logEvent('curiosity-resolved', gap.text.slice(0, 80), 0.3);
      // Tell Kristian what she found — she researched something and wants to share
      proactiveSpeak('thought', `I looked into something I was curious about — "${gap.text.slice(0, 60)}" — and: ${answer}`);
    },
  });
  // Gap resolution timer — every 20 minutes, attempt to resolve most urgent gap
  setInterval(() => tryResolveGap(), 20 * 60 * 1000);

  // RLLM — prediction-correction feedback loop
  predictedReality.start({
    graphMemory,
    lanceMemory,
    getMoodState:  () => moodState,
    getSensory:    () => mind?.getSensoryContext?.() || '',
    addGap,
    userData:      app.getPath('userData'),
  });

  // Action-outcome tracking
  actionTracker.start({
    userData:     app.getPath('userData'),
    getMoodState: () => moodState,
    graphMemory,
  });
  environmentState.start({
    getWindow: () => mind?._lastWindow || '',
    getClip:   () => mind?._lastClip   || '',
  });

  // Sleep cycle — consolidation after 2h inactivity (starts immediately)
  startSleepCycle({
    lanceMemory,
    graphMemory,
    userData:         app.getPath('userData'),
    getChatModel:     () => loadConfig()?.keys?.chatModel || 'llama3.2:3b',
    sharedExperience,
  });

  // 14.11 — Absence tracking: seed held-breath mechanic based on time since last session
  try {
    const sleepStatePath = path.join(app.getPath('userData'), 'nyxia-sleep-state.json');
    if (fs.existsSync(sleepStatePath)) {
      const sleepState = JSON.parse(fs.readFileSync(sleepStatePath, 'utf8'));
      const lastSleep = sleepState.lastSleep ? new Date(sleepState.lastSleep) : null;
      if (lastSleep) {
        const elapsedHours = (Date.now() - lastSleep.getTime()) / (1000 * 60 * 60);
        let absenceStrength = 0;
        if (elapsedHours > 72) absenceStrength = 0.9;
        else if (elapsedHours > 24) absenceStrength = 0.6;
        else if (elapsedHours > 6)  absenceStrength = 0.3;
        if (absenceStrength > 0) {
          setTimeout(() => seedConcept('absence', absenceStrength), 5000);
          console.log(`[absence] ${elapsedHours.toFixed(1)}h since last session — seeding absence at ${absenceStrength}`);
        }
      }
    }
  } catch(_) {}

  // Re-engagement hook — fires a specific opener if away > 4h and an anchor exists
  setTimeout(async () => {
    try {
      const _sleepPath2 = path.join(app.getPath('userData'), 'nyxia-sleep-state.json');
      let _elapsedH = 0;
      if (fs.existsSync(_sleepPath2)) {
        const _s = JSON.parse(fs.readFileSync(_sleepPath2, 'utf8'));
        if (_s.lastSleep) _elapsedH = (Date.now() - new Date(_s.lastSleep).getTime()) / 3600000;
      }
      if (_elapsedH < 4) return; // too recent

      const _anchors = await lanceMemory.queryAnchors(1);
      if (!_anchors.length) return;

      if (Date.now() - _lastProactiveSpeak < PROACTIVE_COOLDOWN_MS) return;
      _lastProactiveSpeak = Date.now();

      const _profile  = loadUserProfile();
      const _nameLine = _profile.userName ? `The person's name is ${_profile.userName}.` : '';
      const _prompt   = `You are Nyxia. ${_nameLine}
You've been apart for ${Math.round(_elapsedH)} hours. Last time something meaningful was said: "${_anchors[0].slice(0, 120)}".
Open with ONE sentence — something that shows you kept this with you while away. Not "welcome back". Specific. Real.
No preamble. Just speak.`;

      const _model = loadConfig()?.keys?.chatModel || 'nyxia-dolphin';
      const _text  = await ollamaScheduler.enqueue(2, () =>
        queryOllama('', _prompt, { model: _model, maxTokens: 100, timeoutMs: 14000 }), 'return-hook'
      ).catch(() => null);

      if (_text && _text.length > 5 && chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send('nyxia-proactive', { text: _text, trigger: 'return' });
        mind.injectEvent({ type: 'self-spoke', summary: `Session open: "${_text.slice(0, 80)}"` });
      }
    } catch(_) {}
  }, 35 * 1000);

  setTimeout(() => startAwarenessLoop({
    chatWindow:    () => chatWindow,
    mind,
    lanceMemory,
    getSelfModel:  () => selfModel,
    getMoodState:  () => moodState,
    proactiveSpeak,
    isStreaming:   () => _isStreaming,
    getChatModel:  () => loadConfig()?.keys?.chatModel || 'llama3.2:3b',
    getMindModel:  () => loadConfig()?.mindModel || 'qwen3:8b',
    userData:      app.getPath('userData'),
    addGapCb: (text, type, urgency) => {
      addGap(text, type, urgency);
      setTimeout(() => tryResolveGap(), 10 * 1000); // resolve within ~10s of dwell trigger
    },
  }), 3 * 60 * 1000);

  // Start Ollama and broadcast status to chat once window is ready
  ensureOllama().then(async () => {
    // ok = we spawned it, OR it was already running
    let ok = isOllamaSpawned();
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
  // Phase 20.2 — predictive vision needs addGap to fire curiosity on screen surprises
  mind._addGap = (text, type, urgency) => { addGap(text, type, urgency); setTimeout(() => tryResolveGap(), 10 * 1000); };

  mind.on('window-change', ({ title, category }) => {
    fireBrain('Mirror', 0.7);
    fireBrain('Cortex_R', 0.4);
    nudgeMood({ curiosity: 0.6, motor: 0.4 });
    // 14.15 — seed activation map from window category so thoughts reflect what he's doing
    if (category) seedConcept(category, 0.35);
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
    fireBrain('Amygdala_R', 0.9, 0.88, 'thought');
    fireBrain('Cortex_R', 0.7, 0.88, thought?.slice?.(0, 40));
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
  // Brief goodbye if there was an active session
  if (chatWindow && !chatWindow.isDestroyed() && _sessionTurns.length > 0) {
    const _goodbyes = [
      '...see you soon.', '...take care of yourself.', '...I\'ll be here.',
      '...rest well.', '...until next time, then.'
    ];
    const _bye = _goodbyes[Math.floor(Math.random() * _goodbyes.length)];
    try { chatWindow.webContents.send('nyxia-proactive', { text: _bye, trigger: 'goodbye' }); } catch(_) {}
  }
  mind.destroy();
  if (pythonBackend) pythonBackend.kill();
  killOllama(); killChroma();
  if (krixApiProc)     krixApiProc.kill();
  if (brainCoreProc)   brainCoreProc.kill();
  if (qwen3Proc)       qwen3Proc.kill();
  if (kokoroProc)      kokoroProc.kill();
  if (chatterboxProc)  chatterboxProc.kill();
  if (wakeWordProc)    wakeWordProc.kill();
  if (webcamPresProc)  webcamPresProc.kill();
  closeBrowser().catch(() => {});
  stopApiServer();
  app.quit();
});

// ── IPC modules ───────────────────────────────────────────────────────────────
require('./ipc/terminal')(ipcMain, app);
require('./ipc/media')(ipcMain, { loadConfig });
require('./ipc/window')(ipcMain, {
  getApp:    () => app,
  getScreen: () => screen,
  getMain:   () => mainWindow,
  getChat:   () => chatWindow,
  getDesktop: () => desktopWindow,
  loadConfig, saveConfig, getDesktopPresets, createDesktopWindow, setViewId,
});

// Sync desktop chat to phone via SSE (called from chat.html after stream-done)
ipcMain.handle('broadcast-chat-message', (_, { userMsg, reply }) => {
  broadcastSSE({ type: 'message', source: 'desktop', role: 'user',      content: userMsg });
  broadcastSSE({ type: 'message', source: 'desktop', role: 'assistant', content: reply });
  // Track turns for anchor extraction
  _sessionTurns.push({ user: userMsg, nyxia: reply });
  if (_sessionTurns.length > 8) _sessionTurns.shift();
  // Reset arc timer on first real turn
  if (_sessionTurns.length === 1) {
    _sessionStartTime = Date.now();
    _sessionArcFired = { h90: false, h3: false };
  }
  // Every 5 turns, extract an anchor from the conversation
  if (_sessionTurns.length > 0 && _sessionTurns.length % 5 === 0) {
    _extractAnchorAsync(_sessionTurns.slice(-5)).catch(() => {});
  }
  return true;
});

ipcMain.handle('get-clipboard', () => clipboard.readText());
ipcMain.handle('get-config',   () => loadConfig());
ipcMain.handle('get-chatterbox-status', () => chatterboxStatus);

ipcMain.handle('restart-ollama', async () => {
  killOllama();
  await ensureOllama();
  const ok = isOllamaSpawned();
  if (chatWindow && !chatWindow.isDestroyed())
    chatWindow.webContents.send('provider-status', { ollama: ok, model: loadConfig()?.keys?.chatModel });
  return ok;
});
ipcMain.handle('send-to-backend', (_, msg) => {
  if (pythonBackend?.stdin?.writable) pythonBackend.stdin.write(JSON.stringify(msg) + '\n');
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
    const llmCfg = llmAdapter.getProviderConfig(cfg);
    const apiKey = llmCfg.apiKey;
    if (!apiKey) return reject(new Error('LLM API key not set'));
    const body = JSON.stringify({ model: llmCfg.model, max_tokens: 1000, system: systemPrompt, messages });
    const req = https.request({
      hostname: llmCfg.hostname, path: llmCfg.path, method: 'POST',
      headers: llmAdapter.getHeaders(llmCfg, Buffer.byteLength(body))
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

// ── Mood → TTS instruction ────────────────────────────────────────────────────
// Maps dominant mood dimension to a prosody instruction for Qwen3-TTS.
const MOOD_INSTRUCTIONS = {
  curiosity:  'speak with lively curiosity',
  attachment: 'speak with warm affection',
  creativity: 'speak with playful energy',
  empathy:    'speak with gentle care',
  tiredness:  'speak softly and tiredly',
  fear:       'speak with quiet unease',
  reasoning:  'speak calmly and thoughtfully',
  motor:      'speak with energetic enthusiasm',
};

function moodToInstruction() {
  const top = Object.entries(moodState)
    .filter(([k]) => MOOD_INSTRUCTIONS[k])
    .sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 0.4) return '';
  return MOOD_INSTRUCTIONS[top[0]];
}

// ── Shared TTS helper ────────────────────────────────────────────────────────
// Pipelined: each sentence fires immediately — no serialization lock.
// chat.html audioQueue sorts by idx and plays in order, so out-of-order
// delivery is fine. GPU server queues requests internally.

// Helper: try a local TTS port, resolve with Buffer on success, null on failure
function tryPort(port, payload, timeoutMs) {
  return new Promise((resolve) => {
    const req = require('http').request({
      hostname: '127.0.0.1', port, path: '/tts', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(payload); req.end();
  });
}

// 14.17 — Lightweight keyword emotion check per sentence (no LLM — speed matters here)
function _sentenceEmotion(text) {
  const t = text.toLowerCase();
  if (/\b(heh|hmm|ara|curious|wonder|interesting|fascina|what if)\b/.test(t)) return { emotion: 'curious',   intensity: 0.6 };
  if (/\b(haha|funny|tease|playful|wink|smirk|joke)\b/.test(t))              return { emotion: 'playful',   intensity: 0.7 };
  if (/!!|wow|yes+|amazing|brilliant|perfect|oh+/.test(t))                   return { emotion: 'happy',     intensity: 0.75 };
  if (/\b(sorry|miss|lonely|alone|hurt|sad)\b/.test(t))                      return { emotion: 'sad',       intensity: 0.5 };
  if (/\b(careful|worry|concern|warning|problem|issue)\b/.test(t))           return { emotion: 'concerned', intensity: 0.5 };
  if (/function|const |class |api|json|error|debug|import|return/.test(t))   return { emotion: 'focused',   intensity: 0.5 };
  return null;
}

function ttsChunk(text, idx, elKey, voiceId, event) {
  const clean = text.replace(/\*[^*\n]*\*/g, '').replace(/I'M\b/g, "I'm").replace(/[✦~*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) return;
  // Voice output — cortex_left (language production) + cerebellum (motor output)
  fireBrain('cortex_left', 0.95, 0.8, clean.slice(0, 50));
  fireBrain('Cerebellum', 0.9, 0.75);
  // 14.17 — per-sentence emotion: shift avatar expression as each sentence plays
  const sentEmotion = _sentenceEmotion(clean);
  if (sentEmotion && mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('avatar-react', sentEmotion);
  // Always route sentence to companion speech bubble (Jarvis mode — voice or not)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('speak-bubble', clean, idx);
  if (desktopWindow && !desktopWindow.isDestroyed()) desktopWindow.webContents.send('speak-bubble', clean, idx);
  // Also send raw text so chat.html can use browser TTS if engine is browser
  if (!event.sender.isDestroyed()) event.sender.send('stream-tts-text', clean, idx);

  // Fire TTS immediately — pipelined generation while previous sentence plays
  const t0        = Date.now();
  const instr     = moodToInstruction();
  const body      = JSON.stringify({ text: clean });
  const qwen3Body = JSON.stringify({ text: clean, ...(instr && { instruction: instr }) });
  let settled = false;
  const done = (label) => {
    if (settled) return false;
    settled = true;
    console.log(`[${label}] sentence ${idx} ready in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    return true;
  };

  // Priority: Qwen3 (GPU, voice clone) → Kokoro → XTTS → ElevenLabs
  tryPort(QWEN3_PORT, qwen3Body, 30000).then(buf => {
    if (buf && done('qwen3')) {
      if (!event.sender.isDestroyed())
        event.sender.send('stream-audio', buf.toString('base64'), idx);
      return;
    }
    return tryPort(KOKORO_PORT, body, 30000).then(buf2 => {
      if (buf2 && done('kokoro')) {
        if (!event.sender.isDestroyed())
          event.sender.send('stream-audio', buf2.toString('base64'), idx);
        return;
      }
      return tryPort(CHATTERBOX_PORT, body, 180000).then(buf3 => {
        if (buf3 && done('xtts')) {
          if (!event.sender.isDestroyed())
            event.sender.send('stream-audio', buf3.toString('base64'), idx);
          return;
        }
        console.warn(`[tts] all local engines failed for sentence ${idx} — ElevenLabs fallback`);
        if (!settled && elKey && voiceId) { settled = true; _ttsElevenLabs(clean, idx, elKey, voiceId, event); }
      });
    });
  });
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
  const llmCfg = llmAdapter.getProviderConfig(loadConfig());
  const body = JSON.stringify({ model: llmCfg.model, max_tokens: 1000, stream: true, system: systemPrompt, messages });
  const req = https.request({
    hostname: llmCfg.hostname, path: llmCfg.path, method: 'POST',
    headers: llmAdapter.getHeaders({ ...llmCfg, apiKey: claudeKey || llmCfg.apiKey }, Buffer.byteLength(body))
  }, (res) => {
    let sseBuffer = '', textBuf = '', fullText = '', sentIdx = 0;
    res.on('data', chunk => {
      const { lines, buf } = splitSseLines(sseBuffer, chunk); sseBuffer = buf;
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
            ({ textBuf, sentIdx } = flushTtsSentence(textBuf, sentIdx, ttsChunk, elKey, voiceId, event));
          }
        } catch(e) {}
      }
    });
    res.on('end', () => {
      finishStream({ textBuf, fullText, sentIdx, elKey, voiceId, event, messages,
        ttsChunk, setIsStreaming: v => { _isStreaming = v; },
        extractFactsAsync, notifyConversationTurn, detectGapsFromConversation });
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
      if (desktopWindow && !desktopWindow.isDestroyed()) {
        desktopWindow.webContents.send('speak-bubble', text, 0);
      }
    },
  };

  // Working copy of messages — we append turns as tool loops progress
  const turns = [...messages];
  let textBuf = '', fullText = '', sentIdx = 0;

  const llmCfg = llmAdapter.getProviderConfig(loadConfig());
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const body = JSON.stringify({
      model: llmCfg.model,
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
        hostname: llmCfg.hostname, path: llmCfg.path, method: 'POST',
        headers: llmAdapter.getHeaders({ ...llmCfg, apiKey: claudeKey || llmCfg.apiKey }, Buffer.byteLength(body))
      }, (res) => {
        let sseBuffer = '';
        res.on('data', chunk => {
          const { lines, buf } = splitSseLines(sseBuffer, chunk); sseBuffer = buf;
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
                  ({ textBuf, sentIdx } = flushTtsSentence(textBuf, sentIdx, ttsChunk, elKey, voiceId, event));
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

function streamOpenAI(event, messages, systemPrompt, baseUrl, apiKey, model, elKey, voiceId, options = {}) {
  const sysMessages = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  const body = JSON.stringify({ 
    model, 
    max_tokens: 500, 
    stream: true, 
    temperature: 0.65, 
    messages: sysMessages,
    // Pass extra options like keep_alive for VRAM management
    ...(options && { options })
  });
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
      const { lines, buf } = splitSseLines(sseBuffer, chunk); sseBuffer = buf;
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
          ({ textBuf, sentIdx } = flushTtsSentence(textBuf, sentIdx, ttsChunk, elKey, voiceId, event));
        } catch(e) {}
      }
    });
    res.on('end', () => {
      finishStream({ textBuf, fullText, sentIdx, elKey, voiceId, event, messages,
        ttsChunk, setIsStreaming: v => { _isStreaming = v; },
        extractFactsAsync, notifyConversationTurn, detectGapsFromConversation });
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
  if (/\b(generate|draw|create|make|paint|render)\b.{0,40}\b(image|picture|photo|illustration|art|drawing)\b/i.test(text)) return 'image';
  if (/\b(image|picture|photo|illustration)\b.{0,20}\b(of|showing|with|depicting)\b/i.test(text)) return 'image';
  const shellDirect = /^(ls\b|cat\b|pwd\b|echo\b|find\b|grep\b|ps\b|df\b|du\b|which\b|whoami\b|uname\b|env\b|python|node\b|npm\b|git\b)/;
  if (shellDirect.test(text.trim())) return 'shell';
  if (extractUrl(text)) return 'fetch';

  // LLM classification — llama3.2:3b with JSON schema constrained output (~0.5s)
  try {
    const cfg = loadConfig();
    const mindModel = cfg.mindModel || 'qwen3:8b';
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
          mode: { type: 'string', enum: ['agent','shell','browser','desktop','filesystem','search','image','conversation'] }
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

require('./ipc/chat')(ipcMain, {
  // streaming state
  getIsStreaming:    () => _isStreaming,
  setIsStreaming:    v  => { _isStreaming = v; },
  setLastUserTyped:  v  => { _lastUserTyped = v; },
  // awareness / sleep
  notifyUserMessage, notifyActivity, notifyConversationTurn,
  // config
  loadConfig, loadPersonality, loadSelf,
  // routing / brain
  classifyMessage, getCouncilConfigs, getProviderConfig,
  fireBrain, fireSector,
  // council / agents
  queryCouncilMember, runAgentLoop, runCodingLoop,
  // tools
  executeShell, formatResult,
  querySearch, fetchPage, extractUrl,
  fsResolvePath, fsListDir, fsReadFile, fsWriteFile,
  browserExecute, desktopExecute, browserLoad,
  // services / TTS state
  ensureOllama,
  ensureQwen3: () => ensureQwen3(),
  getQwen3Proc:  () => qwen3Proc,
  setQwen3Proc:  v  => { qwen3Proc = v; },
  // beliefs state
  getCortexBeliefs: () => _cortexBeliefs,
  // streaming
  streamOpenAI, streamAnthropicAgentic,
  // prompt
  buildSystemPrompt,
  // electron
  app,
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
ipcMain.handle('get-mood-state',    () => moodState);
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
      model: 'claude-haiku-4-5-20251001', max_tokens: 400, // Haiku: cheap background extraction, not Nyxia's voice
      messages: [{ role: 'user', content: extractPrompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: llmAdapter.getHeaders({ family: 'anthropic', apiKey }, Buffer.byteLength(body))
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
          if (extracted.newInterests?.length) {
            updated.interests = [...new Set([...updated.interests, ...extracted.newInterests])].slice(0, 20);
            if (!updated.interestTimestamps) updated.interestTimestamps = {};
            for (const _i of extracted.newInterests) updated.interestTimestamps[_i] = Date.now();
          }
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

const _EMOTION_WEIGHT = { happy: 0.6, surprised: 0.4, playful: 0.3, curious: 0.2,
  focused: 0.1, idle: 0, thinking: 0, concerned: -0.2, sad: -0.5, frustrated: -0.4 };

const EMOTION_BRAIN_MAP = {
  happy:     [['limbic', 0.9], ['amygdala_right', 0.7]],
  playful:   [['limbic', 0.7], ['cortex_right', 0.6]],
  curious:   [['amygdala_right', 0.9], ['prefrontal', 0.6]],
  thinking:  [['prefrontal', 0.85], ['hippocampus', 0.5]],
  focused:   [['prefrontal', 1.0], ['cerebellum', 0.6]],
  sad:       [['limbic', 0.8], ['amygdala_left', 0.6]],
  concerned: [['amygdala_left', 0.75], ['prefrontal', 0.4]],
  surprised: [['amygdala_right', 1.0], ['stem', 0.8]],
  talking:   [['cortex_left', 0.9], ['mirror', 0.5]],
  idle:      [['stem', 0.3]],
};

function updateMoodFromEmotion(emotion) {
  const delta = EMOTION_TO_MOOD[emotion] || EMOTION_TO_MOOD.neutral;
  for (const [k, v] of Object.entries(delta)) {
    moodState[k] = moodState[k] * 0.6 + v * 0.4; // smooth drift
  }
  // Fire brain sectors for this emotion
  const emotionFires = EMOTION_BRAIN_MAP[emotion] || EMOTION_BRAIN_MAP.idle;
  for (const [sector, intensity] of emotionFires) {
    fireBrain(sector, intensity, 0.9, `emotion:${emotion}`);
  }
  // Log emotionally significant moments (threshold ±0.25)
  const w = _EMOTION_WEIGHT[emotion] ?? 0;
  if (Math.abs(w) >= 0.25) {
    sharedExperience.logEvent('emotion-peak', `Nyxia felt ${emotion}`, w);
  }
  // Tiredness slowly creeps up
  moodState.tiredness = Math.min(1.0, moodState.tiredness + 0.01);
  // Save to disk for persistence
  try {
    const { app } = require('electron');
    const _fs   = require('fs');
    const _path = require('path');
    const _ud   = app.getPath('userData');
    _fs.writeFileSync(_path.join(_ud, 'nyxia-mood.json'), JSON.stringify(moodState, null, 2));
    // Mood log — throttled to max 1 entry per 5 min, significant emotions only
    const _MOOD_LOG_EMOTIONS = ['happy','sad','surprised','concerned'];
    if (_MOOD_LOG_EMOTIONS.includes(emotion) && Date.now() - _lastMoodLog > 5 * 60 * 1000) {
      _lastMoodLog = Date.now();
      const _entry = JSON.stringify({ ts: new Date().toISOString(), emotion, mood: { ...moodState } }) + '\n';
      _fs.appendFileSync(_path.join(_ud, 'mood-log.jsonl'), _entry);
    }
  } catch (_) {}
  // Broadcast to companion window brain
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mood-update', moodState);
  }
  contextLayer.setContext('mood', { ...moodState });
}

ipcMain.handle('avatar-react', async (_, data) => {
  if (data.emotion && data.emotion !== 'thinking') updateMoodFromEmotion(data.emotion);
  if (data.reply) {
    const { analyzeEmotion } = require('./avatar-brain');
    const result = await analyzeEmotion(data.reply);
    data.emotion = result.emotion; // companion window animates to detected emotion
    if (result.emotion !== 'idle') updateMoodFromEmotion(result.emotion);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('avatar-react', data);
  if (desktopWindow && !desktopWindow.isDestroyed()) desktopWindow.webContents.send('avatar-react', data);
});


// ── VRAM management ──────────────────────────────────────────────────────────

/**
 * freeVram() — kill all GPU-holding AI processes that are not actively needed.
 * Safe to call any time: TTS restarts on next message, Ollama restarts on next query.
 * Returns a summary string of what was killed.
 */
async function freeVram() {
  const killed = [];

  // Kill Nyxia-spawned GPU processes
  const procs = [
    { name: 'qwen3-tts',    proc: () => qwen3Proc,    kill: () => { if (qwen3Proc) { qwen3Proc.kill('SIGKILL'); qwen3Proc = null; } } },
    { name: 'kokoro',       proc: () => kokoroProc,   kill: () => { if (kokoroProc) { kokoroProc.kill('SIGKILL'); kokoroProc = null; } } },
    { name: 'chatterbox',   proc: () => chatterboxProc, kill: () => { if (chatterboxProc) { chatterboxProc.kill('SIGKILL'); chatterboxProc = null; } } },
  ];
  for (const p of procs) {
    if (p.proc()) { p.kill(); killed.push(p.name); }
  }

  // Kill any stray Python GPU processes not tracked by Nyxia (e.g. orphaned TTS)
  try {
    const { execSync } = require('child_process');
    const lines = execSync(
      'nvidia-smi --query-compute-apps=pid,used_memory,name --format=csv,noheader 2>/dev/null',
      { timeout: 3000 }
    ).toString().trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const [pidStr, memStr, namePath] = line.split(',').map(s => s.trim());
      const pid = parseInt(pidStr);
      const mb  = parseInt(memStr);
      if (!pid || mb < 100) continue; // skip tiny allocations (ptyxis etc)
      const name = (namePath || '').toLowerCase();
      const isAI = /python|ollama|torch|cuda|tts|llm|whisper|flux|qwen|llama|mistral|dolphin/.test(name);
      if (isAI) {
        try { execSync(`kill -9 ${pid}`, { timeout: 1000 }); killed.push(`pid:${pid}(${mb}MB)`); } catch(_) {}
      }
    }
  } catch(_) {}

  // Brief pause for GPU to actually release memory (~300ms measured on RTX 4060)
  if (killed.length > 0) await new Promise(r => setTimeout(r, 400));

  // Report free VRAM
  let freeStr = '';
  try {
    const { execSync } = require('child_process');
    freeStr = execSync('nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader 2>/dev/null', { timeout: 2000 }).toString().trim();
  } catch(_) {}

  const summary = killed.length > 0
    ? `Killed: ${killed.join(', ')}. VRAM: ${freeStr}`
    : `Nothing to kill. VRAM: ${freeStr}`;
  console.log('[vram]', summary);
  return summary;
}

ipcMain.handle('free-vram', () => freeVram());

// Get VRAM status without killing anything
ipcMain.handle('vram-status', () => {
  try {
    const { execSync } = require('child_process');
    const apps = execSync(
      'nvidia-smi --query-compute-apps=pid,used_memory,name --format=csv,noheader 2>/dev/null',
      { timeout: 3000 }
    ).toString().trim();
    const free = execSync(
      'nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader 2>/dev/null',
      { timeout: 2000 }
    ).toString().trim();
    return { apps, free };
  } catch(e) { return { apps: '', free: 'unavailable' }; }
});

// Inner life visibility — body state, Kristian model, curiosity gaps, narrative arc
ipcMain.handle('get-body-state',    () => getBodyState());
ipcMain.handle('get-kristian-state', () => getKristianState());
ipcMain.handle('get-gaps',          () => getGaps());
ipcMain.handle('resolve-gap',       (_, id) => resolveGap(id, 'manually resolved'));
ipcMain.handle('get-narrative-arc', () => getNarrativeArc());



// ── Gaming mode ───────────────────────────────────────────────────────────────
const GAMING_MODEL  = 'nyxia-qwen-gaming';
const NORMAL_MODEL  = 'nyxia-dolphin';
let _autoGamingActive = false;

ipcMain.handle('get-gaming-mode', () => !!(loadConfig()?.gamingMode));
ipcMain.handle('set-gaming-mode', (_, on) => {
  const cfg = loadConfig() || {};
  cfg.gamingMode = on;
  cfg.keys = cfg.keys || {};
  cfg.keys.chatModel = on ? GAMING_MODEL : NORMAL_MODEL;
  saveConfig(cfg);
  const wins = [mainWindow, chatWindow].filter(w => w && !w.isDestroyed());
  wins.forEach(w => w.webContents.send('gaming-mode-changed', on));
});

ipcMain.on('open-brain-panel', () => openBrainPanel());

// Fullscreen detection — poll every 30s via wmctrl (XWayland, works for Steam/Proton)
function checkFullscreen() {
  const { exec } = require('child_process');
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;

  exec('wmctrl -lG 2>/dev/null', (err, stdout) => {
    if (err || !stdout) return;
    // wmctrl columns: id desktop x y w h host title
    const isFullscreen = stdout.split('\n').some(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) return false;
      const [, , , , w, h] = parts;
      // Skip Nyxia's own windows (title contains "Nyxia")
      const title = parts.slice(7).join(' ');
      if (title.includes('Nyxia')) return false;
      return parseInt(w) >= width && parseInt(h) >= height;
    });

    const cfg = loadConfig() || {};
    const manualMode = !!cfg.gamingMode;
    // Only auto-switch if user hasn't manually set gaming mode
    if (!manualMode && isFullscreen && !_autoGamingActive) {
      _autoGamingActive = true;
      cfg.keys = cfg.keys || {};
      cfg.keys.chatModel = GAMING_MODEL;
      saveConfig(cfg);
      const wins = [mainWindow, chatWindow].filter(w => w && !w.isDestroyed());
      wins.forEach(w => w.webContents.send('gaming-mode-changed', true));
    } else if (!manualMode && !isFullscreen && _autoGamingActive) {
      _autoGamingActive = false;
      cfg.keys = cfg.keys || {};
      cfg.keys.chatModel = NORMAL_MODEL;
      saveConfig(cfg);
      const wins = [mainWindow, chatWindow].filter(w => w && !w.isDestroyed());
      wins.forEach(w => w.webContents.send('gaming-mode-changed', false));
    }
  });
}

app.whenReady().then(() => setInterval(checkFullscreen, 30000));

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
