'use strict';

// TTS, mic, VAD, streaming audio queue
// Deps: { ipcRenderer, getAddMsg, getSendMessage, getIncrementVoiceCounter, getIsStreaming, setIsStreaming }
// Exposes window globals called by HTML onclick/onchange

// ── TTSPlayer ─────────────────────────────────────────────────────────────────
// Single owner of all TTS state. Eliminates the three divergent paths that
// previously shared audioCtx and vadSpeaking via scattered closure variables.
//
// External API (all exposed as window globals):
//   enqueueAudio(b64, idx)   — streaming AudioContext path
//   speakBrowser(text, idx)  — SpeechSynthesis path
//   cancelTTS()              — cut all audio immediately
//   resetAudio()             — reset for new stream (replaces 4-line state reset in chat.html)
//   markStreamDone()         — signal no more chunks coming (replaces streamDone=true + idle check)

class TTSPlayer {
  constructor({ onSpeakStart, onSpeakEnd }) {
    this._onSpeakStart = onSpeakStart; // called when audio begins
    this._onSpeakEnd   = onSpeakEnd;   // called when all audio finishes

    // AudioContext queue state
    this._audioCtx      = null;
    this._currentSource = null;
    this._queue         = [];   // { b64, idx }[]
    this._playing       = false;
    this._nextIdx       = 0;
    this._streamDone    = false;

    // Browser SpeechSynthesis queue state
    this._bQueue    = [];   // { text, idx }[]
    this._bSpeaking = false;
  }

  // Reset for a new message stream — call before sending each message.
  reset() {
    this._queue      = [];
    this._bQueue     = [];
    this._playing    = false;
    this._nextIdx    = 0;
    this._streamDone = false;
    this._bSpeaking  = false;
  }

  // Enqueue a b64 audio chunk from IPC (AudioContext path).
  enqueueAudio(b64, idx) {
    this._queue.push({ b64, idx });
    this._queue.sort((a, b) => a.idx - b.idx);
    this._drain();
  }

  // Enqueue a text sentence (SpeechSynthesis path).
  enqueueBrowser(text, idx) {
    if (!window.speechSynthesis) return;
    this._bQueue.push({ text, idx });
    this._bQueue.sort((a, b) => a.idx - b.idx);
    this._drainBrowser();
  }

  // Signal that no more audio chunks are coming.
  // If already idle, fires onSpeakEnd immediately.
  setStreamDone() {
    this._streamDone = true;
    if (this.isIdle()) this._onSpeakEnd?.();
  }

  // True when nothing is playing or queued.
  isIdle() {
    return !this._playing && this._queue.length === 0 &&
           !this._bSpeaking && this._bQueue.length === 0;
  }

  // Cancel all audio immediately and reset queue state.
  cancel() {
    if (this._currentSource) { try { this._currentSource.stop(); } catch(e) {} this._currentSource = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    this._queue      = [];
    this._bQueue     = [];
    this._nextIdx    = 0;
    this._playing    = false;
    this._bSpeaking  = false;
    this._streamDone = true;
    this._onSpeakEnd?.();
  }

  async _drain() {
    if (this._playing) return;
    const next = this._queue.find(a => a.idx === this._nextIdx);
    if (!next) return;
    this._queue = this._queue.filter(a => a !== next);
    this._playing = true;
    this._onSpeakStart?.();
    try {
      if (!this._audioCtx) this._audioCtx = new AudioContext();
      if (this._audioCtx.state === 'suspended') await this._audioCtx.resume();
      const binary = atob(next.b64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const buffer = await this._audioCtx.decodeAudioData(bytes.buffer.slice(0));
      this._currentSource = this._audioCtx.createBufferSource();
      this._currentSource.buffer = buffer;
      this._currentSource.connect(this._audioCtx.destination);
      this._currentSource.onended = () => {
        this._playing = false;
        this._nextIdx++;
        this._currentSource = null;
        if (this._queue.length === 0 && this._streamDone) this._onSpeakEnd?.();
        this._drain();
      };
      this._currentSource.start();
    } catch(e) {
      this._playing = false;
      this._nextIdx++;
      this._drain();
    }
  }

  _drainBrowser() {
    if (this._bSpeaking || this._bQueue.length === 0) return;
    const next = this._bQueue.shift();
    const utt  = new SpeechSynthesisUtterance(next.text);
    utt.rate = 1.05; utt.pitch = 1.1; utt.volume = 1.0;
    const voices = speechSynthesis.getVoices();
    const female = voices.find(v => /female|woman|girl/i.test(v.name)) ||
                   voices.find(v => v.lang.startsWith('en')) || voices[0];
    if (female) utt.voice = female;
    this._bSpeaking = true;
    this._onSpeakStart?.();
    utt.onend = utt.onerror = () => {
      this._bSpeaking = false;
      if (this._bQueue.length === 0 && this._streamDone) this._onSpeakEnd?.();
      this._drainBrowser();
    };
    speechSynthesis.speak(utt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = function initAudio(deps) {
  const { ipcRenderer, getAddMsg, getSendMessage, getIncrementVoiceCounter, getIsStreaming, setIsStreaming } = deps;

  // Voice input — MediaRecorder + Whisper
  let mediaRecorder = null;
  let audioChunks   = [];
  let isListening   = false;
  let visAnalyser   = null;
  let visFrame      = null;
  let visCtx        = null;

  function startLevelVis(stream) {
    if (visCtx) { try { visCtx.close(); } catch(e) {} visCtx = null; }
    visCtx         = new AudioContext();
    visAnalyser    = visCtx.createAnalyser();
    visAnalyser.fftSize = 64;
    visCtx.createMediaStreamSource(stream).connect(visAnalyser);
    const data     = new Uint8Array(visAnalyser.frequencyBinCount);
    const bars     = document.querySelectorAll('#mic-level span');
    const levelEl  = document.getElementById('mic-level');
    levelEl.classList.add('active');

    function draw() {
      visFrame = requestAnimationFrame(draw);
      visAnalyser.getByteFrequencyData(data);
      bars.forEach((bar, i) => {
        const idx   = Math.floor(i * data.length / bars.length);
        const pct   = data[idx] / 255;
        bar.style.height = Math.max(3, pct * 20) + 'px';
        bar.style.opacity = 0.4 + pct * 0.6;
      });
    }
    draw();
  }

  function stopLevelVis() {
    if (visFrame) { cancelAnimationFrame(visFrame); visFrame = null; }
    if (visCtx)   { try { visCtx.close(); } catch(e) {} visCtx = null; }
    document.getElementById('mic-level').classList.remove('active');
    document.querySelectorAll('#mic-level span').forEach(b => { b.style.height = '3px'; });
  }

  async function toggleMic() {
    if (isListening) {
      isListening = false;
      updateMicBtn();
      stopLevelVis();
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      return;
    }
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      mediaRecorder  = new MediaRecorder(stream, { mimeType });
      audioChunks    = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (audioChunks.length === 0) return;
        const blob   = new Blob(audioChunks, { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = reader.result.split(',')[1];
          showTypingOnMic();
          const text = await ipcRenderer.invoke('transcribe-audio', base64);
          hideTypingOnMic();
          if (text?.trim()) {
            document.getElementById('chat-input').value = text.trim();
            getIncrementVoiceCounter()();
            getSendMessage()();
          } else {
            getAddMsg()('nyxia', '[Whisper returned nothing — check audio or ffmpeg]');
          }
        };
        reader.readAsDataURL(blob);
      };
      isListening = true;
      updateMicBtn();
      startLevelVis(stream);
      mediaRecorder.start();
    } catch(e) {
      getAddMsg()('nyxia', "Microphone access denied~ Check system permissions.");
    }
  }

  function updateMicBtn() {
    document.getElementById('mic-btn').classList.toggle('listening', isListening);
  }

  // ── Always-on voice mode ──────────────────────────────────────────────────
  let voiceMode      = false;
  let vadStream      = null;
  let vadAudioCtx    = null;
  let vadAnalyser    = null;
  let vadFrame       = null;
  let vadCapturing   = false;
  let vadRecorder    = null;
  let vadChunks      = [];
  let vadSilenceTimer = null;
  let vadSpeaking    = false;   // true while TTS is playing

  const VAD_THRESHOLD  = 22;    // avg frequency energy 0-255 (raised: 14 was too sensitive)
  const VAD_SILENCE_MS = 900;   // ms of quiet before sending

  async function toggleVoiceMode() {
    if (voiceMode) { stopVoiceMode(); return; }
    try {
      vadStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch(e) {
      getAddMsg()('nyxia', "Microphone access denied~"); return;
    }
    voiceMode = true;
    updateLiveBtn('listening');
    startLevelVis(vadStream);

    vadAudioCtx  = new AudioContext();
    vadAnalyser  = vadAudioCtx.createAnalyser();
    vadAnalyser.fftSize = 256;
    vadAudioCtx.createMediaStreamSource(vadStream).connect(vadAnalyser);
    const data = new Uint8Array(vadAnalyser.frequencyBinCount);

    // setInterval instead of requestAnimationFrame — runs even when window is hidden
    vadFrame = setInterval(() => {
      if (!voiceMode) { clearInterval(vadFrame); vadFrame = null; return; }
      if (vadAudioCtx?.state === 'suspended') vadAudioCtx.resume();
      vadAnalyser.getByteFrequencyData(data);
      const avg = Array.from(data.slice(0, 20)).reduce((a, b) => a + b) / 20;
      if (avg > VAD_THRESHOLD) {
        if (vadSpeaking) {
          cancelTTS(); // barge-in — cut Nyxia's speech
          setIsStreaming(false); // allow next message after barge-in
        }
        // Don't start capturing while Nyxia is still generating a response
        if (!vadCapturing && !getIsStreaming()) { vadCapturing = true; startVadCapture(); }
        if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
      } else if (vadCapturing && !vadSilenceTimer) {
        vadSilenceTimer = setTimeout(() => {
          vadSilenceTimer = null;
          if (vadCapturing) { vadCapturing = false; flushVadCapture(); }
        }, VAD_SILENCE_MS);
      }
    }, 50);
  }

  function startVadCapture() {
    vadChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    vadRecorder = new MediaRecorder(vadStream, { mimeType });
    vadRecorder.ondataavailable = (e) => { if (e.data.size > 0) vadChunks.push(e.data); };
    vadRecorder.start(100);
  }

  function flushVadCapture() {
    if (!vadRecorder || vadRecorder.state === 'inactive') return;
    vadRecorder.onstop = async () => {
      if (!voiceMode || vadChunks.length === 0) return;
      const blob   = new Blob(vadChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result.split(',')[1];
        showTypingOnMic();
        const text = await ipcRenderer.invoke('transcribe-audio', base64);
        hideTypingOnMic();
        if (text?.trim() && voiceMode) {
          document.getElementById('chat-input').value = text.trim();
          getIncrementVoiceCounter()();
          getSendMessage()();
        }
      };
      reader.readAsDataURL(blob);
    };
    vadRecorder.stop();
  }

  // Instantiate the unified TTS player — single owner of all audio queue state.
  const ttsPlayer = new TTSPlayer({
    onSpeakStart: () => { vadSpeaking = true;  updateLiveBtn('speaking'); },
    onSpeakEnd:   () => { vadSpeaking = false; if (voiceMode) updateLiveBtn('listening'); },
  });

  function cancelTTS() {
    ttsPlayer.cancel();
  }

  function stopVoiceMode() {
    voiceMode = false;
    if (vadFrame)        { clearInterval(vadFrame); vadFrame = null; }
    if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
    if (vadRecorder && vadRecorder.state !== 'inactive') vadRecorder.stop();
    if (vadStream)       { vadStream.getTracks().forEach(t => t.stop()); vadStream = null; }
    if (vadAudioCtx)     { vadAudioCtx.close(); vadAudioCtx = null; }
    stopLevelVis();
    vadCapturing = false; vadSpeaking = false;
    updateLiveBtn('off');
  }

  function updateLiveBtn(state) {
    const btn = document.getElementById('live-btn');
    btn.classList.remove('listening', 'speaking');
    if (state !== 'off') btn.classList.add(state);
  }

  let micTypingEl = null;
  function showTypingOnMic() {
    if (micTypingEl) return;
    micTypingEl = document.createElement('div');
    micTypingEl.className = 'msg nyxia';
    micTypingEl.innerHTML = '<div class="msg-label">Nyxia</div><div style="font-size:11px;opacity:0.5;padding:2px 0">transcribing...</div>';
    const box = document.getElementById('messages');
    box.appendChild(micTypingEl); box.scrollTop = box.scrollHeight;
  }
  function hideTypingOnMic() {
    if (micTypingEl) { micTypingEl.remove(); micTypingEl = null; }
  }

  // ── TTS engine helpers ────────────────────────────────────────────────────

  let _cachedTTSEngine = null;
  function currentTTSEngine() {
    // Cached so we don't await inside hot event handlers — refreshed on save
    return _cachedTTSEngine || 'browser';
  }
  async function refreshTTSEngine() {
    const p = await ipcRenderer.invoke('get-personality');
    _cachedTTSEngine = p.voice?.ttsEngine || 'browser';
  }

  // Thin public wrappers — delegate to TTSPlayer
  function enqueueAudio(b64, idx) { ttsPlayer.enqueueAudio(b64, idx); }
  function speakBrowser(text, idx) { ttsPlayer.enqueueBrowser(text, idx); }

  // Called by chat.html at the START of each message send (replaces 4-line direct state reset).
  function resetAudio() { ttsPlayer.reset(); }

  // Called by chat.html onDone handler (replaces `streamDone = true` + inline idle check).
  function markStreamDone() {
    ttsPlayer.setStreamDone();
  }

  // Expose as window globals for HTML onclick/onchange and sendMessage in chat.html
  window.toggleMic        = toggleMic;
  window.toggleVoiceMode  = toggleVoiceMode;
  window.cancelTTS        = cancelTTS;
  window.stopVoiceMode    = stopVoiceMode;
  window.enqueueAudio     = enqueueAudio;
  window.speakBrowser     = speakBrowser;
  window.resetAudio       = resetAudio;
  window.markStreamDone   = markStreamDone;
  window.currentTTSEngine = currentTTSEngine;
  window.refreshTTSEngine = refreshTTSEngine;
  window.micIsListening   = () => isListening;
};
