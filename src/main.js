const { app, BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const chokidar = require('chokidar');
const logger = require('./utils/logger');
const { OLLAMA_URL } = require('./config/ollama-endpoint');
const mind        = require('./mind');
const { fireSector, getSelfBelief, migrateFromSelfJson, setMainWindow } = require('./brain-soul');
const lanceMemory = require('./lance-memory');
const graphMemory = require('./graph-memory');
const { startAwarenessLoop, getThoughtBank, notifyUserMessage, seedConcept, notifyPresence, getPendingReturns } = require('./awareness-loop');
const { startInteroception, getBodyState }                                   = require('./interoception');
const { startOtherModel, notifyConversationTurn, getOtherModelContext, getKristianState, getMutualModelContext } = require('./other-model');
const { startCuriosityEngine, detectGapsFromConversation, getGaps, resolveGap, tryResolveGap, addGap, setSyslog: setCuriositySyslog } = require('./curiosity-gaps');
const predictedReality  = require('./predicted-reality');
const actionTracker     = require('./action-tracker');
const environmentState  = require('./environment-state');
const { startSleepCycle, getMorningThought, getNarrativeArc, notifyActivity } = require('./sleep-cycle');
const { browserExecute, closeBrowser, setViewId, browserLoad } = require('./browser');
const { desktopExecute } = require('./desktop');
const { executeShell, formatResult } = require('./shell');
const { runAgentLoop, runCodingLoop } = require('./agent-loop');
const { NYXIA_TOOLS, runTool } = require('./nyxia-tools');
const bridgeClient = require('./bridge-client');
const { startApiServer, stopApiServer, broadcastSSE } = require('./api-server');
const { queryOllama, parseJsonObject } = require('./utils/ollama-client');
const ollamaScheduler = require('./utils/ollama-scheduler');
const contextLayer      = require('./context-layer');
const sharedExperience  = require('./shared-experience');
const { loadConfig, saveConfig, loadPersonality, savePersonality, loadSelf, saveSelf, loadUserProfile, saveUserProfile, getPrivacy, appendAudit } = require('./config-manager');
const { ensureChroma, ensureOllama, ensureReflex, waitForVram, killChroma, killOllama, killReflex, isOllamaSpawned } = require('./service-startup');
const { SEARXNG_URL, querySearch, extractUrl, fetchPage, fsResolvePath, fsSanitize, fsWriteFile } = require('./tools');
const { splitSseLines, flushTtsSentence, finishStream } = require('./ipc/streaming');
const { startClaudeWatcher } = require('./claude-watcher');
const krixMemory    = require('./krix-memory');
const llmAdapter    = require('./llm/adapter');
const memoryManager = require('./memory-manager');
const ttsServers    = require('./tts/servers');
const ttsPipeline   = require('./tts/pipeline');
const providers     = require('./llm/providers');
const router        = require('./llm/router');
const krixBrain     = require('./services/krix-brain');
const { ensureSearXNG } = require('./services/searxng');
const facts         = require('./memory/facts');
const heartbeat     = require('./awareness/heartbeat');
const selfModelMod  = require('./awareness/self-model');
const proactive     = require('./awareness/proactive');

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
let _lanceReflections     = [];
let _graphContext         = null;
let _screenInterpretation = null;
// _krixContext → krixBrain.getKrixContext()
// krixApiProc/brainCoreProc → internal to services/krix-brain.js
// _learnedFacts + facts helpers → memory/facts.js

// extractFactsAsync → memory/facts.js
const extractFactsAsync = facts.extractFactsAsync.bind(facts);

// Interpret raw Screenpipe OCR through qwen2.5vl:7b — removes 3B refusal issue.
// Fire-and-forget: result cached for next system prompt build.
async function interpretScreen(ocrText) {
  if (!ocrText || ocrText.length < 10) return;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
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
    krixBrain.refreshKrixContext(ctx || dynamicQuery).catch(() => {});
  } catch (e) { _lanceReflections = []; }
}

// selfModel lives in awareness/self-model.js — reference the same object
const selfModel = selfModelMod.selfModel;

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
  getSelfModel:            () => selfModelMod.getSelfModel(),
  getMoodState:            () => moodState,
  getLanceReflections:     () => _lanceReflections,
  getCortexBeliefs:        () => selfModelMod.getCortexBeliefs(),
  getGraphContext:         () => _graphContext,
  getScreenInterpretation: () => _screenInterpretation,
  getLearnedFacts:         () => facts.getLearnedFacts(),
  getKrixBrainContext:     () => krixBrain.getKrixContext(),
  getMindState:            () => mind.getState(),
  getThoughtBank:          () => getThoughtBank(),
  getGaps:                 () => getGaps(),
  getBodyState:            () => getBodyState(),
  getRecentEvents:         () => sharedExperience.getSignificant(0.3),
});


// ── Module initialization ─────────────────────────────────────────────────────
krixBrain.init({ krixMemory });
facts.init({ getDataPath: () => app.getPath('userData'), loadConfig });
ttsServers.init({ getChatWindow: () => chatWindow, waitForVram });
ttsPipeline.init({
  getMoodState:    () => moodState,
  fireBrain,
  getMainWindow:   () => mainWindow,
  getDesktopWindow: () => desktopWindow,
});
router.init({ loadConfig, loadUserProfile, loadSelf, extractUrl, ollamaScheduler, queryOllama });
selfModelMod.init({
  mind, getMoodState: () => moodState,
  ollamaScheduler, queryOllama, parseJsonObject,
  getSelfBelief, loadSelf,
  selfModelPath: path.join(app.getPath('userData'), 'nyxia-selfmodel.json'),
});
proactive.init({
  getChatWindow:    () => chatWindow,
  getMainWindow:    () => mainWindow,
  getDesktopWindow: () => desktopWindow,
  fireBrain, mind, lanceMemory, ollamaScheduler, queryOllama,
  loadConfig, loadUserProfile, loadSelf,
});
heartbeat.init({
  mind, getMoodState: () => moodState, getSelfModel: selfModelMod.getSelfModel,
  ollamaScheduler, queryOllama,
  proactiveSpeak: proactive.proactiveSpeak,
  addGap, tryResolveGap, loadConfig,
  fetchUncertainQueue: krixMemory.listUncertainFollowups,
  fetchStaleSignals: krixMemory.listStalePipelineSignals,
});

// Jarvis (krix-brain) queues a task here when it can't confidently classify
// it — heartbeat surfaces it via proactive.proactiveSpeak('uncertain_task', ...).
// When Kristian answers with a worker name, resolve the followup and route
// the task in ourselves rather than re-running Jarvis's classifier on it.
async function tryResolveUncertainTask(userMsg) {
  const pending = proactive.getPendingUncertainTask();
  if (!pending) return null;
  const WORKERS = ['scout', 'ava', 'tom', 'bobby'];
  const lc = (userMsg || '').toLowerCase();
  const chosen = WORKERS.find(w => lc.includes(w));
  if (!chosen) return null; // not an answer to this — leave it queued, don't hijack the turn

  proactive.clearPendingUncertainTask();
  const matchText = pending.task.slice(0, 60);
  await krixMemory.resolveFollowup(matchText).catch(() => {});
  await krixMemory.recordJarvisResolution(pending.task, chosen).catch(() => {});
  const dispatchRes = await krixMemory.dispatchTask(chosen, pending.task).catch(() => null);
  return dispatchRes?.response
    ? `Sending it to ${chosen}. ${dispatchRes.response}`
    : `Sending it to ${chosen} — marked the queue entry resolved.`;
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-brain-panel.js'),
    },
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

// ── KRIX-BRAIN API → services/krix-brain.js ──────────────────────────────────
const ensureKrixApi       = krixBrain.ensureKrixApi.bind(krixBrain);
const ensureBrainCore     = krixBrain.ensureBrainCore.bind(krixBrain);
const ensureMcpDaemon     = krixBrain.ensureMcpDaemon.bind(krixBrain);
const refreshKrixContext  = krixBrain.refreshKrixContext.bind(krixBrain);

// ── Service startup (ensureChroma/ensureOllama/ensureFlux/waitForVram) ────────
// Extracted to src/service-startup.js

// ── TTS servers → src/tts/servers.js ─────────────────────────────────────────
const { QWEN3_PORT, KOKORO_PORT, CHATTERBOX_PORT } = ttsServers;

// ── Wake word ─────────────────────────────────────────────────────────────────
const WAKE_WORD_BIN = process.execPath.includes('electron')
  ? '/usr/bin/python3'
  : 'python3';
const WAKE_WORD_SRV    = path.join(__dirname, '..', 'wake_word.py');
const WEBCAM_PRES_SRV  = path.join(__dirname, '..', 'webcam_haptics.py');
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
      const raw = line.trim();
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch(_) { continue; }

      if (msg.type === 'hand') {
        // Forward finger position to space.html (mainWindow)
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('hand-pos', { x: msg.x, y: msg.y, pinch: msg.pinch });
        continue;
      }

      if (msg.type === 'presence') {
        const present = msg.state === 'PRESENT';
        console.log(`[webcam-haptics] ${msg.state}`);
        sendSyslog(present ? 'PRESENCE · KRISTIAN DETECTED' : 'PRESENCE · FRAME EMPTY');
        contextLayer.setContext('scene', { userPresent: present, ts: Date.now() });
        sharedExperience.logEvent(
          present ? 'user-arrived' : 'user-left',
          present ? 'Kristian appeared on camera' : 'Kristian left the camera frame',
          present ? 0.2 : -0.1
        );
        if (chatWindow && !chatWindow.isDestroyed())
          chatWindow.webContents.send('webcam-presence', { present });

        notifyPresence(present);

        if (present && _webcamAbsentSince) {
          const absentMs  = Date.now() - _webcamAbsentSince;
          const absentMin = Math.round(absentMs / 60000);
          _webcamAbsentSince = null;
          if (absentMs > 10 * 60 * 1000) {
            const pending = getPendingReturns();
            if (pending.length > 0) {
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

// TTS server lifecycle → src/tts/servers.js
const sendChatterboxStatus = ttsServers.sendChatterboxStatus.bind(ttsServers);
const ensureChatterbox     = ttsServers.ensureChatterbox.bind(ttsServers);
const ensureQwen3          = ttsServers.ensureQwen3.bind(ttsServers);
const ensureKokoro         = ttsServers.ensureKokoro.bind(ttsServers);
// ensureSearXNG imported from services/searxng.js

// ── Screenpipe removed — vision via desktopCapturer + qwen2.5vl:7b (mind.js) ─

// Web/FS tools extracted to src/tools.js

// ── Proactive speech → src/awareness/proactive.js ────────────────────────────
let _sessionTurns      = [];
let _sessionStartTime  = Date.now();
let _sessionArcFired   = { h90: false, h3: false };
let _webcamAbsentSince = null;
let _lastMoodLog       = 0;

const proactiveSpeak      = proactive.proactiveSpeak.bind(proactive);
const _extractAnchorAsync = proactive._extractAnchorAsync.bind(proactive);

// ── Heartbeat → src/awareness/heartbeat.js ───────────────────────────────────
const startHeartbeat       = heartbeat.startHeartbeat.bind(heartbeat);
const canHeartbeatInterrupt = heartbeat.canHeartbeatInterrupt.bind(heartbeat);

// Short Ollama call for edge labeling — injected into writeReflection as callOllama
async function _callMindModel(prompt) {
  const model = loadConfig()?.mindModel || 'nyxia-ft';
  return (await ollamaScheduler.enqueue(3, () => queryOllama('', prompt, { model, maxTokens: 30, timeoutMs: 8000 }), 'edge-label')) || '';
}

// ── Self-Model + Cortex beliefs → src/awareness/self-model.js ────────────────
const updateSelfModel      = selfModelMod.updateSelfModel.bind(selfModelMod);
const refreshCortexBeliefs = selfModelMod.refreshCortexBeliefs.bind(selfModelMod);

// ── Vessel daemon integration ─────────────────────────────────────────────────
// Pings the vessel (port 7424) on start to record absence, drains queued
// observations and surfaces them through the awareness engine.
// Also polls every 60s mid-session so observations arrive continuously.
const http = require('http');
function _vesselFetch(method, vesselPath, cb) {
  const req = http.request({ hostname: '127.0.0.1', port: 7424, path: vesselPath, method }, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => { try { cb(null, JSON.parse(body)); } catch { cb(null, {}); } });
  });
  req.on('error', cb);
  req.end();
}

function _drainVesselQueue(absentMins = 0) {
  _vesselFetch('GET', '/vessel/queue', (err, queue) => {
    if (err || !Array.isArray(queue) || !queue.length) return;
    console.log(`[vessel] draining ${queue.length} observation(s)`);
    queue.slice(0, 5).forEach((obs, i) => {
      setTimeout(() => {
        mind.injectEvent({ type: `vessel-${obs.type}`, summary: obs.summary });
        if (obs.type === 'absence' && absentMins > 60) {
          proactiveSpeak('heartbeat', obs.summary);
        } else if (obs.type === 'high_load') {
          proactiveSpeak('highload', obs.summary);
        } else if (obs.type === 'screen_unlock' && obs.lockedMins > 5) {
          proactiveSpeak('heartbeat', obs.summary);
        }
      }, (i + 1) * 4000);
    });
  });
}

function _initVessel() {
  // Ping — records absence before resetting the clock
  _vesselFetch('POST', '/vessel/ping', (err, pong) => {
    if (err) { console.log('[vessel] not running — start nyxia-vessel.service'); return; }
    const absentMins = Math.round((pong.prevAbsenceMs || 0) / 60_000);
    console.log(`[vessel] ping ok — was absent: ${pong.wasAbsent} (${absentMins}min)`);

    if (pong.wasAbsent && absentMins > 0)
      mind.injectEvent({ type: 'vessel-return', summary: `Nyxia was alone for ${absentMins} minutes` });

    // Startup drain — wait for awareness loop to warm up
    setTimeout(() => _drainVesselQueue(absentMins), 8000);
  });

  // Mid-session poll — drain new observations every 60s
  setInterval(() => _drainVesselQueue(), 60_000);
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
  ensureReflex();

  // Start KRIX-BRAIN API server (unified memory substrate)
  ensureKrixApi();
  // Start brain-core neural layer (ports 7422 + 7423: agent API + spike bus)
  ensureBrainCore();
  // Start KRIX-BRAIN MCP daemon (port 7425: tool access, MCP-first search)
  ensureMcpDaemon();

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
  setTimeout(() => startWebcamPresence(), 5000);
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

  // Vessel daemon — ping on start, drain queued observations
  _initVessel();

  // Other-model — theory of mind for Kristian (starts immediately)
  startOtherModel({
    userData:      app.getPath('userData'),
    getMindModel:  () => loadConfig()?.mindModel || 'nyxia-ft',
    getNyxiaState: () => ({ mood: moodState, selfModel }),
  });

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
    getMindModel:  () => loadConfig()?.mindModel || 'nyxia-ft',
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
      try { const r = await fetch(`${OLLAMA_URL}/api/version`); ok = r.ok; } catch(_) {}
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
    getMood:    () => moodState,
    watchDirs: [
      path.join(os.homedir(), 'projects'),
      path.join(os.homedir(), 'dev'),
      path.join(os.homedir(), 'Documents'),
    ].filter(d => { try { return fs.existsSync(d); } catch { return false; } })
  });
  // Phase 20.2 — predictive vision needs addGap to fire curiosity on screen surprises
  mind._addGap = (text, type, urgency) => { addGap(text, type, urgency); setTimeout(() => tryResolveGap(), 10 * 1000); };

  // ── Syslog relay — sends real events to the space.html terminal panel ──────
  const sendSyslog = (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('syslog', line);
  };
  setCuriositySyslog(sendSyslog);
  proactive.setSyslog(sendSyslog);

  // Real mood pulse every 30s
  setInterval(() => {
    const top = Object.entries(moodState)
      .filter(([, v]) => v > 0.25)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k.slice(0,6).toUpperCase()}:${Math.round(v * 100)}%`)
      .join(' ');
    sendSyslog(`MOOD · ${top || 'BASELINE'}`);
  }, 30000);

  mind.on('window-change', ({ title, category }) => {
    fireBrain('Mirror', 0.7);
    fireBrain('Cortex_R', 0.4);
    nudgeMood({ curiosity: 0.6, motor: 0.4 });
    if (category) seedConcept(category, 0.35);
    if (mainWindow) mainWindow.webContents.send('mind-window-change', { title, category });
    if (desktopWindow && !desktopWindow.isDestroyed()) desktopWindow.webContents.send('mind-window-change', { title, category });
    sendSyslog(`WINDOW · ${(title || '').slice(0, 36).toUpperCase()}`);
    if (Math.random() < 0.30) proactiveSpeak('window', title);
  });
  mind.on('file-change', ({ name, ext }) => {
    fireBrain('Mirror', 0.5);
    fireBrain('Hippocampus', 0.4);
    nudgeMood({ reasoning: 0.5, memory_load: 0.4 });
    if (mainWindow) mainWindow.webContents.send('mind-file-change', { name, ext });
    if (desktopWindow && !desktopWindow.isDestroyed()) desktopWindow.webContents.send('mind-file-change', { name, ext });
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
    if (desktopWindow && !desktopWindow.isDestroyed()) desktopWindow.webContents.send('mind-clipboard-change', text);
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
    if (desktopWindow && !desktopWindow.isDestroyed()) desktopWindow.webContents.send('mind-thought', thought);
    sendSyslog(`THOUGHT · ${(thought || '').slice(0, 52).toUpperCase()}`);
    if (Math.random() < 0.50) proactiveSpeak('thought', thought);
  });
  mind.on('high-load', ({ loadPct }) => {
    fireBrain('Stem', 0.9);
    fireBrain('Amygdala_L', Math.min(1.0, loadPct / 100));
    nudgeMood({ tiredness: Math.min(1, loadPct / 100), fear: Math.min(0.6, loadPct / 150) });
    if (mainWindow) mainWindow.webContents.send('mind-high-load', { loadPct });
    if (desktopWindow && !desktopWindow.isDestroyed()) desktopWindow.webContents.send('mind-high-load', { loadPct });
    sendSyslog(`LOAD · ${loadPct}% — THERMAL SPIKE`);
    if (loadPct > 75 && Math.random() < 0.60) proactiveSpeak('highload', String(loadPct));
  });
  mind.on('syslog', line => sendSyslog(line));

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
  killOllama(); killChroma(); killReflex();
  ttsServers.killAll();
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

ipcMain.on('log', (_, msg) => console.log(msg));

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
  // Reflex layer — fire-and-forget soul state update
  fetch('http://127.0.0.1:8788/reflex', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: userMsg }),
    signal: AbortSignal.timeout(3000),
  }).then(r => r.ok && r.json()).then(soul => {
    if (!soul) return;
    for (const [k, v] of Object.entries(soul)) {
      if (k !== 'heartbeat' && moodState[k] !== undefined)
        moodState[k] = moodState[k] * 0.8 + v * 0.2;
    }
  }).catch(() => {});
  return true;
});

ipcMain.handle('get-clipboard', () => clipboard.readText());
ipcMain.handle('get-config',   () => loadConfig());
ipcMain.handle('patch-config', (_, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
  const cfg = loadConfig();
  const merged = Object.assign({}, cfg);
  const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  for (const [k, v] of Object.entries(patch)) {
    if (BLOCKED_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = Object.assign({}, cfg[k] || {});
      for (const [sk, sv] of Object.entries(v)) {
        if (BLOCKED_KEYS.has(sk)) continue;
        sub[sk] = sv;
      }
      merged[k] = sub;
    } else {
      merged[k] = v;
    }
  }
  saveConfig(merged);
  return true;
});
ipcMain.handle('get-chatterbox-status', () => ttsServers.getChatterboxStatus());

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

// Keys IPC — secret fields are masked before being sent to the renderer so they
// never appear in plaintext in renderer memory / devtools. The settings form
// shows a placeholder when a key is present; on save, if the value equals the
// placeholder we keep the existing stored value instead of overwriting with it.
const KEY_PLACEHOLDER = '••••••••';
const SECRET_FIELDS   = ['anthropic', 'elevenlabs', 'openai'];

ipcMain.handle('load-keys', () => {
  const cfg  = loadConfig() || {};
  const keys = { ...(cfg.keys || {}) };
  for (const f of SECRET_FIELDS) {
    if (keys[f]) keys[f] = KEY_PLACEHOLDER;
  }
  return keys;
});
ipcMain.handle('save-keys', (_, keys) => {
  if (!keys || typeof keys !== 'object') return;
  const cfg     = loadConfig() || {};
  const current = cfg.keys || {};
  const merged  = { ...current };
  for (const [k, v] of Object.entries(keys)) {
    // Don't overwrite a stored secret with the display placeholder
    if (SECRET_FIELDS.includes(k) && v === KEY_PLACEHOLDER) continue;
    merged[k] = v;
  }
  cfg.keys = merged;
  saveConfig(cfg);
});

// Claude API — non-streaming fallback (used by text-only path)
ipcMain.handle('claude-chat', (_, messages, systemPrompt) => {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    const llmCfg = llmAdapter.getProviderConfig(cfg);

    // Local Ollama (nyxia-ft, qwen3, etc)
    if (llmCfg.family === 'openai' && llmCfg.hostname === '127.0.0.1' && llmCfg.port !== 3456) {
      const { queryOllama } = require('./utils/ollama-client');
      queryOllama(systemPrompt, messages[messages.length - 1]?.content || '', {
        model: llmCfg.model, maxTokens: 1000, timeoutMs: 120000
      }).then(text => text ? resolve(text) : reject(new Error('No response from Ollama')))
        .catch(reject);
      return;
    }

    const body = JSON.stringify({ model: llmCfg.model, max_tokens: 1000, system: systemPrompt, messages });
    const transport = llmCfg.secure === false ? require('http') : https;
    const req = transport.request({
      hostname: llmCfg.hostname, path: llmCfg.path, method: 'POST',
      ...(llmCfg.port ? { port: llmCfg.port } : {}),
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

// ── TTS pipeline → src/tts/pipeline.js ───────────────────────────────────────
const ttsChunk        = ttsPipeline.ttsChunk.bind(ttsPipeline);
const moodToInstruction = ttsPipeline.moodToInstruction.bind(ttsPipeline);
const tryPort         = ttsPipeline.tryPort;

// ── SSE streaming helpers ────────────────────────────────────────────────────
function streamAnthropic(event, messages, systemPrompt, claudeKey, elKey, voiceId) {
  const llmCfg = llmAdapter.getProviderConfig(loadConfig());
  const body = JSON.stringify({ model: llmCfg.model, max_tokens: 1000, stream: true, system: systemPrompt, messages });
  const transport = llmCfg.secure === false ? require('http') : https;
  const req = transport.request({
    hostname: llmCfg.hostname, path: llmCfg.path, method: 'POST',
    ...(llmCfg.port ? { port: llmCfg.port } : {}),
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
    bridgeOpenFile, bridgeReadFile, bridgeListFiles,
    setMood: (state, intensity = 0.8) => {
      updateMoodFromEmotion(state);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('avatar-react', { emotion: state, intensity });
      }
      if (desktopWindow && !desktopWindow.isDestroyed()) {
        desktopWindow.webContents.send('avatar-react', { emotion: state, intensity });
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
      const transport = llmCfg.secure === false ? require('http') : https;
      const req = transport.request({
        hostname: llmCfg.hostname, path: llmCfg.path, method: 'POST',
        ...(llmCfg.port ? { port: llmCfg.port } : {}),
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
  // Join onto the base path — new URL('/v1/...', base) would discard base paths
  // like Groq's /openai/v1 or Gemini's /v1beta/openai/
  let _base = baseUrl.replace(/\/+$/, '');
  if (new URL(_base).pathname === '/') _base += '/v1';
  const url  = new URL(_base + '/chat/completions');
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

// ── LLM providers + router → src/llm/providers.js + src/llm/router.js ────────
const getCouncilConfigs  = providers.getCouncilConfigs;
const queryCouncilMember = providers.queryCouncilMember;
const getProviderConfig  = providers.getProviderConfig;
const classifyMessage    = router.classifyMessage;

// ── Harness-scoped tools → src/bridge-client.js + claude-bridge POST /mcp ────
// Token is re-read from config on every call (not captured once at startup),
// consistent with how getProviderConfig(loadConfig()) is read fresh elsewhere.
const bridgeOpenFile  = (path, app) => bridgeClient.bridgeOpenFile(path, loadConfig()?.keys?.bridgeTokenNyxia, app);
const bridgeReadFile  = path => bridgeClient.bridgeReadFile(path, loadConfig()?.keys?.bridgeTokenNyxia);
const bridgeListFiles = path => bridgeClient.bridgeListFiles(path, loadConfig()?.keys?.bridgeTokenNyxia);

// fs_read/fs_list now go through the same scoped /mcp check as bridge_read_file/
// bridge_list_files, closing the bypass where a rejected bridge_read_file call
// fell back to an unrestricted local read. fs_write is untouched — not in
// Nyxia's declared tool_scope, tracked separately in AGENT_TOOL_SCOPE.md.
const fsReadFile = path => bridgeClient.bridgeReadFile(path, loadConfig()?.keys?.bridgeTokenNyxia);
const fsListDir  = path => bridgeClient.bridgeListFiles(path, loadConfig()?.keys?.bridgeTokenNyxia);

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
  // jarvis uncertain-task queue → src/awareness/proactive.js + krix-memory.js
  tryResolveUncertainTask,
  // council / agents
  queryCouncilMember, runAgentLoop, runCodingLoop,
  // tools
  executeShell, formatResult,
  querySearch, fetchPage, extractUrl,
  fsResolvePath, fsListDir, fsReadFile, fsWriteFile,
  browserExecute, desktopExecute, browserLoad,
  // harness-scoped tools (claude-bridge)
  bridgeOpenFile, bridgeReadFile, bridgeListFiles,
  // services / TTS state
  ensureOllama,
  ensureQwen3: () => ttsServers.ensureQwen3(),
  getQwen3Proc:  ttsServers.getQwen3Proc,
  setQwen3Proc:  ttsServers.setQwen3Proc,
  // beliefs state
  getCortexBeliefs: selfModelMod.getCortexBeliefs,
  // streaming
  streamOpenAI, streamAnthropicAgentic,
  // prompt
  buildSystemPrompt,
  // mood
  getMoodState: () => moodState,
  // vision — voluntary look
  lookNow: () => mind.lookNow(),
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
  killed.push(...ttsServers.killAll());

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
