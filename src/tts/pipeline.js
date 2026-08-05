'use strict';
// tts/pipeline.js — sentence-level TTS dispatch.
// Pipelined: each sentence fires immediately, chat.html audioQueue sorts by idx.

const https = require('https');
const { QWEN3_PORT, KOKORO_PORT, CHATTERBOX_PORT } = require('./servers');

let _deps = {};

function init(deps) {
  // { getMoodState, fireBrain, getMainWindow, getDesktopWindow }
  _deps = deps;
}

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
  const moodState = _deps.getMoodState();
  const top = Object.entries(moodState)
    .filter(([k]) => MOOD_INSTRUCTIONS[k])
    .sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 0.4) return '';
  return MOOD_INSTRUCTIONS[top[0]];
}

// Lightweight keyword emotion check per sentence — no LLM, speed matters here
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

// Try a local TTS port — resolves with Buffer on success, null on failure
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
    req.write(payload);
    req.end();
  });
}

function _ttsElevenLabs(clean, idx, elKey, voiceId, event) {
  const b = JSON.stringify({
    text: clean, model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
  });
  const req = https.request({
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': elKey, 'Content-Length': Buffer.byteLength(b) },
  }, (res) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      if (!event.sender.isDestroyed())
        event.sender.send('stream-audio', Buffer.concat(chunks).toString('base64'), idx);
    });
  });
  req.on('error', () => {});
  req.write(b);
  req.end();
}

function ttsChunk(text, idx, elKey, voiceId, event) {
  const clean = text
    .replace(/\*[^*\n]*\*/g, '')
    .replace(/I'M\b/g, "I'm")
    .replace(/[✦~*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 2) return;

  const { fireBrain, getMainWindow, getDesktopWindow } = _deps;
  fireBrain('cortex_left', 0.95, 0.8, clean.slice(0, 50));
  fireBrain('Cerebellum',  0.9,  0.75);

  const sentEmotion = _sentenceEmotion(clean);
  const mainWin = getMainWindow();
  if (sentEmotion && mainWin && !mainWin.isDestroyed())
    mainWin.webContents.send('avatar-react', sentEmotion);

  if (mainWin && !mainWin.isDestroyed())       mainWin.webContents.send('speak-bubble', clean, idx);
  const desktopWin = getDesktopWindow();
  if (desktopWin && !desktopWin.isDestroyed()) desktopWin.webContents.send('speak-bubble', clean, idx);
  if (!event.sender.isDestroyed())             event.sender.send('stream-tts-text', clean, idx);

  const t0       = Date.now();
  const instr    = moodToInstruction();
  const body     = JSON.stringify({ text: clean });
  const qwen3Body = JSON.stringify({ text: clean, ...(instr && { instruction: instr }) });
  let settled = false;
  const done = (label) => {
    if (settled) return false;
    settled = true;
    console.log(`[${label}] sentence ${idx} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return true;
  };

  // Priority: Qwen3 → Kokoro → Chatterbox → ElevenLabs
  tryPort(QWEN3_PORT, qwen3Body, 30000).then(buf => {
    if (buf && done('qwen3')) {
      if (!event.sender.isDestroyed()) event.sender.send('stream-audio', buf.toString('base64'), idx);
      return;
    }
    return tryPort(KOKORO_PORT, body, 30000).then(buf2 => {
      if (buf2 && done('kokoro')) {
        if (!event.sender.isDestroyed()) event.sender.send('stream-audio', buf2.toString('base64'), idx);
        return;
      }
      return tryPort(CHATTERBOX_PORT, body, 180000).then(buf3 => {
        if (buf3 && done('xtts')) {
          if (!event.sender.isDestroyed()) event.sender.send('stream-audio', buf3.toString('base64'), idx);
          return;
        }
        console.warn(`[tts] all local engines failed for sentence ${idx} — ElevenLabs fallback`);
        if (!settled && elKey && voiceId) { settled = true; _ttsElevenLabs(clean, idx, elKey, voiceId, event); }
      });
    });
  });
}

module.exports = { init, ttsChunk, tryPort, moodToInstruction, _sentenceEmotion, MOOD_INSTRUCTIONS };
