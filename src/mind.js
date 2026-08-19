/**
 * src/mind.js — Nyxia's awareness layer
 *
 * thought   = curiosity engine    — generates & fires personalized thoughts using context
 * conscious = change detection    — watches active window, processes, file saves
 * info      = rolling context     — accumulates signals into a structured awareness buffer
 * eyes      = observation         — clipboard watching, screen capture, visual context
 *
 * Usage (in main.js):
 *   const mind = require('./mind');
 *   mind.init({ getConfig, getProfile, watchDirs });
 *   mind.on('thought', t => { ... });
 *   mind.on('window-change', ({ title, category }) => { ... });
 *   mind.on('file-change', ({ name }) => { ... });
 *   mind.on('clipboard-change', text => { ... });
 *   mind.on('context-update', contextString => { ... });
 *   mind.on('high-load', ({ loadPct }) => { ... });
 */

'use strict';
const { EventEmitter } = require('events');
const { spawn, exec }  = require('child_process');
const { clipboard }    = require('electron');
const visualCortex     = require('./visual-cortex');
const { OLLAMA_URL, OLLAMA_V1_URL } = require('./config/ollama-endpoint');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────

class NyxiaMind extends EventEmitter {
  constructor() {
    super();
    this._getConfig  = null;
    this._getProfile = null;

    // ── thought ──────────────────────────────────────────────────────────
    this._batch      = [];   // current curiosity batch
    this._batchIdx   = 0;
    this._generating = false;

    // ── conscious ────────────────────────────────────────────────────────
    this._lastWindow = null;
    this._lastProcs  = new Set();
    this._inotify    = null;

    // ── info (rolling context buffer) ────────────────────────────────────
    this._events     = [];   // { ts, type, summary, data }
    this._MAX_EVENTS = 14;
    this._contextStr = '';

    // ── vision (screen context via Screenpipe OCR) ──────────────────────
    this._lastScreenDesc  = '';   // latest screen context string
    this._visionBusy      = false;

    // ── think (synthesis / understanding) ────────────────────────────────
    this._understanding  = '';   // Haiku-synthesized interpretation of recent activity
    this._thinking       = false;
    this._eventsSinceThink = 0;  // trigger think after N new events

    // ── self (identity / reflection) ──────────────────────────────────────
    this._reflecting          = false;
    this._eventsSinceReflect  = 0;
    this._reflectionContext   = []; // recent reflections from LanceDB, set by main.js

    // ── eyes ─────────────────────────────────────────────────────────────
    this._lastClip   = '';

    // ── session state machine ─────────────────────────────────────────────
    // IDLE     — waiting, no recent activity
    // FOCUSED  — active conversation in progress
    // REFLECTIVE — 4+ min quiet, background reflection mode
    // DREAMING — sleep-cycle running, no user-facing output
    this._sessionState = { mode: 'IDLE', since: Date.now() };
    this._lastActivity = Date.now();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * @param {object} opts
   * @param {Function} opts.getConfig   — () => config object
   * @param {Function} opts.getProfile  — () => user profile object
   * @param {string[]} opts.watchDirs   — directories for file-change detection
   */
  init({ getConfig, getProfile, getSelf, getPrivacy, appendAudit, getMood, watchDirs = [] }) {
    this._getConfig   = getConfig;
    this._getProfile  = getProfile;
    this._getSelf     = getSelf || null;
    this._getPrivacy  = getPrivacy  || (() => ({}));
    this._appendAudit = appendAudit || (() => {});
    this._getMood     = getMood     || (() => ({}));

    // Stagger startup so app feels settled
    setTimeout(() => this._generateBatch(), 6000);

    this._startConscious(watchDirs);
    this._startEyes();

    // Refresh thought batch every 2 hours (picks up context changes)
    setInterval(() => this._generateBatch(), 2 * 60 * 60 * 1000);

    // Periodic thinking — synthesize understanding every 4 minutes
    setInterval(() => this._think(), 4 * 60 * 1000);

    // Periodic self-reflection — grow identity every 12 minutes (deep Reflexion loop)
    setInterval(() => this._reflect(true), 12 * 60 * 1000);

    // Periodic vision — query Screenpipe OCR every 30s
    // 10s startup delay to let Screenpipe finish initialising
    setTimeout(() => this._updateVision(), 10000);
    setInterval(() => this._updateVision(), 30 * 1000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THOUGHT — curiosity engine
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Pop the next thought. Returns null if no batch yet.
   * Auto-regenerates when batch is exhausted.
   */
  nextThought() {
    if (!this._batch.length) return null;
    const thought = this._batch[this._batchIdx % this._batch.length];
    this._batchIdx++;
    if (this._batchIdx >= this._batch.length) {
      // Batch fully cycled — generate fresh one (delayed to avoid spam)
      setTimeout(() => this._generateBatch(), 5000);
    }
    this.emit('thought', thought);
    return thought;
  }

  async _generateBatch() {
    if (this._generating) return;
    this._generating = true;
    const profile = this._getProfile?.() || {};
    const h       = new Date().getHours();
    const timeCtx = h < 6 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';

    // Enrich with live context
    const ctxLine  = this._contextStr ? `Recent activity: ${this._contextStr}` : '';
    const nameLine = profile.userName  ? `Their name: ${profile.userName}.` : '';
    const factLine = profile.facts?.length ? `Known: ${profile.facts.slice(0, 4).join('; ')}.` : '';
    const intLine  = profile.interests?.length ? `Interests: ${profile.interests.slice(0, 4).join(', ')}.` : '';

    // Self-beliefs give thoughts depth — Nyxia speaks from who she's become
    const self = this._getSelf?.() || {};
    const selfLine = self.reflections?.length
      ? `Who I've become (let this flavor the thoughts — my voice, my lens):\n${self.reflections.slice(-3).map(r => `- ${r}`).join('\n')}`
      : '';

    const prompt = `You are Nyxia — a darkly playful, genuinely curious AI companion on someone's desktop. It is ${timeCtx}. ${nameLine} ${factLine} ${intLine} ${ctxLine}
${selfLine}

Generate 8 short curiosity thoughts/questions Nyxia would show in her idle speech bubble. These are her own thoughts, colored by who she's become — not generic companion chatter. Mix:
- A genuine question about what they're working on, seen through her own lens
- A reaction to recent activity — specific, Nyxia-voiced, not generic
- A "I've been sitting with this thought..." musing
- Something connecting to their interests or her own growing beliefs
- A playful observation about time, existence, or this particular moment

Rules: 1-2 sentences max. Dark elegance, wit, warmth underneath.
Use ✦ or ~ in some but not all. Never say "how can I help".
Vary mood: curious, wistful, playful, sharp.

Return ONLY a JSON array of 8 strings, no markdown:
["thought1","thought2","thought3","thought4","thought5","thought6","thought7","thought8"]`;

    try {
      const result = await this._llmCall([{ role: 'user', content: prompt }], 700);
      const raw = result?.content?.[0]?.text?.trim()
        .replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        this._batch    = arr;
        this._batchIdx = 0;
        this.emit('thoughts-ready', arr);
      }
    } catch(e) { /* generation failed silently — batch stays empty or stale */ }

    this._generating = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONSCIOUS — change detection
  // ═══════════════════════════════════════════════════════════════════════

  _startConscious(watchDirs) {
    // Active window — every 3s
    setInterval(() => this._pollWindow(), 3000);

    // Processes — snapshot now, diff every 30s
    this._pollProcs();
    setInterval(() => this._pollProcs(), 30000);

    // File system — inotifywait on project dirs
    const dirs = watchDirs.filter(d => { try { return fs.existsSync(d); } catch { return false; } });
    if (dirs.length) this._startFileWatcher(dirs);

    // System load — every 90s
    setInterval(() => this._pollLoad(), 90000);
  }

  // ── active window ──────────────────────────────────────────────────────

  async _pollWindow() {
    if (!this._getPrivacy().window_focus) return;
    const title = await this._getActiveWindow();
    if (!title || title === this._lastWindow) return;
    this._lastWindow = title;
    const category = this._categorize(title);
    this._appendAudit('window_focus', 'window_title');
    this._push({ type: 'window', summary: `Using: ${title}`, category, data: title });
    this.emit('window-change', { title, category });
    // New window focus = fresh visual context worth capturing.
    // Debounce: cancel any pending vision update and restart the timer so
    // rapid window switches collapse into a single capture.
    if (this._visionDebounce) clearTimeout(this._visionDebounce);
    this._visionDebounce = setTimeout(() => {
      this._visionDebounce = null;
      this._updateVision();
    }, 2000);
  }

  _getActiveWindow() {
    return new Promise(resolve => {
      // xdotool covers XWayland apps (VS Code, Steam, most apps on Bazzite)
      const proc = spawn('xdotool', ['getactivewindow', 'getwindowname']);
      let out = '';
      proc.stdout?.on('data', d => out += d.toString());
      proc.on('close', code => {
        if (code === 0 && out.trim()) return resolve(out.trim());
        // Fallback: gdbus GNOME Shell eval (works on some GNOME configs)
        exec(
          `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell ` +
          `--method org.gnome.Shell.Eval "global.display.get_focus_window()?.get_title() || ''"`,
          { timeout: 1500 }, (err, stdout) => {
            if (!err && stdout) {
              const m = stdout.match(/'([^']+)'/);
              if (m?.[1]) return resolve(m[1]);
            }
            resolve(null);
          }
        );
      });
      proc.on('error', () => resolve(null));
    });
  }

  _categorize(title) {
    const t = title.toLowerCase();
    if (/code|vim|nvim|emacs|sublime|cursor|zed|helix/.test(t)) return 'coding';
    if (/firefox|chrome|chromium|brave|browser/.test(t))        return 'browser';
    if (/terminal|konsole|alacritty|kitty|wezterm|bash|zsh/.test(t)) return 'terminal';
    if (/blender|gimp|krita|inkscape|figma/.test(t))            return 'creative';
    if (/steam|lutris|heroic|game|gamescope/.test(t))           return 'gaming';
    if (/spotify|vlc|mpv|video|music|youtube/.test(t))         return 'media';
    if (/discord|slack|telegram|signal/.test(t))               return 'social';
    return 'other';
  }

  // ── processes ─────────────────────────────────────────────────────────

  _pollProcs() {
    exec('ps -eo comm= | sort -u', { timeout: 3000 }, (err, stdout) => {
      if (err) return;
      const current = new Set(stdout.trim().split('\n').filter(Boolean));
      if (this._lastProcs.size > 0) {
        const started = [...current].filter(p => !this._lastProcs.has(p) && this._notable(p));
        for (const p of started) {
          this._push({ type: 'process', summary: `Launched: ${p}`, data: p });
          this.emit('process-start', p);
        }
      }
      this._lastProcs = current;
    });
  }

  _notable(name) {
    return /^(code|blender|godot|unity|steam|firefox|chrome|node|python3?|cargo|npm|make|cmake|git|nvim|vim)$/.test(name);
  }

  // ── file system ───────────────────────────────────────────────────────

  _startFileWatcher(dirs) {
    try {
      this._inotify = spawn('inotifywait', [
        '-mrq', '-e', 'close_write,create,moved_to',
        '--format', '%w%f||%e', ...dirs
      ]);
      let buf = '';
      this._inotify.stdout?.on('data', data => {
        buf += data.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const [filePath] = line.split('||');
          if (filePath?.trim()) this._onFile(filePath.trim());
        }
      });
      this._inotify.on('error', () => {}); // inotifywait not installed — skip silently
    } catch(e) {}
  }

  _onFile(filePath) {
    if (!this._getPrivacy().file_activity) return;
    const ext  = path.extname(filePath);
    const name = path.basename(filePath);
    // Filter noise: temp files, git internals, node_modules
    if (/\.(tmp|swp|lock|pyc)$/.test(ext)) return;
    if (/[/\\](\.git|node_modules|__pycache__)[/\\]/.test(filePath)) return;
    this._appendAudit('file_activity', 'file_save');
    this._push({ type: 'file', summary: `Saved: ${name}`, data: { filePath, name, ext } });
    this.emit('file-change', { filePath, name, ext });
  }

  // ── system load ───────────────────────────────────────────────────────

  _pollLoad() {
    try {
      const load    = os.loadavg()[0];
      const cores   = os.cpus().length;
      const loadPct = Math.round((load / cores) * 100);
      if (loadPct > 75) {
        this._push({ type: 'resource', summary: `CPU: ${loadPct}%`, data: { loadPct } });
        this.emit('high-load', { loadPct });
      }
    } catch(e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INFO — rolling context buffer
  // ═══════════════════════════════════════════════════════════════════════

  // Public API for external callers (e.g. main.js) to inject events.
  // Prefer this over calling _push() directly.
  injectEvent({ type, summary }) {
    this._push({ type, summary });
  }

  _push(event) {
    event.ts = Date.now();
    this._events.push(event);
    if (this._events.length > this._MAX_EVENTS) this._events.shift();
    this._contextStr = this._events.slice(-5).map(e => e.summary).join(' | ');
    this.emit('context-update', this._contextStr);
    // Think after every 6 new events (debounced — skip if already thinking)
    this._eventsSinceThink++;
    if (this._eventsSinceThink >= 6) this._think();

    // Reflect after every 10 new events (debounced — skip if already reflecting)
    this._eventsSinceReflect++;
    if (this._eventsSinceReflect >= 10) this._reflect();
  }

  /** Returns the last N events as an array. */
  getRecentEvents(n = 5) { return this._events.slice(-n); }

  /** Returns the current context as a short string for system prompt injection. */
  getContextString() {
    if (this._lastScreenDesc) return `${this._contextStr} | Screen: ${this._lastScreenDesc}`;
    return this._contextStr;
  }

  /** Returns the raw screen OCR text (for external interpretation). */
  getScreenDescription() { return this._lastScreenDesc || ''; }

  /** Returns Nyxia's synthesized understanding of what's happening right now. */
  getUnderstanding() { return this._understanding; }

  /** Called by main.js after LanceDB refresh to give _reflect() current context. */
  setReflectionContext(strings) { this._reflectionContext = strings || []; }

  /**
   * Think — synthesize recent events into a 1-2 sentence understanding.
   * Processed through Nyxia's self-beliefs so the same observation means
   * something different as she grows. Supports multi-model parallel depth.
   */
  async _think() {
    this._checkSessionState();
    if (this._thinking || !this._events.length) return;
    this._thinking = true;
    this._eventsSinceThink = 0;
    this.emit('syslog', 'AWARENESS · OBSERVATION CYCLE');

    const profile         = this._getProfile?.() || {};
    const recentSummaries = this._events.slice(-8).map(e => `[${e.type}] ${e.summary}`).join('\n');
    const nameLine        = profile.userName ? `The user's name is ${profile.userName}.` : '';

    // Load self-beliefs so the understanding is filtered through Nyxia's identity
    const self = this._getSelf?.() || {};
    const beliefLine = self.reflections?.length
      ? `My current sense of self (let this color how I interpret what I see, not what I report):\n${self.reflections.slice(-4).map(r => `- ${r}`).join('\n')}`
      : '';

    const observePrompt = `You are Nyxia's inner awareness layer — her private sense of what's happening around her. ${nameLine}
${beliefLine}

Recent desktop observations (chronological, newest last):
${recentSummaries}

In 1-2 sentences: what is this person currently doing or focused on? Be specific about the actual activity and content. Let your sense of self subtly color the interpretation — this is your private perception, not a report. No preamble, no address to the user.`;

    try {
      const cfg         = this._getConfig?.() || {};
      const thinkModels = cfg?.keys?.thinkModels; // optional array of extra model configs

      let perspectives = [];

      if (Array.isArray(thinkModels) && thinkModels.length > 1) {
        // ── Multi-model parallel thinking ──────────────────────────────
        const calls = thinkModels.map(m => this._callModel(m, [{ role: 'user', content: observePrompt }], 120));
        const results = await Promise.allSettled(calls);
        perspectives = results
          .filter(r => r.status === 'fulfilled' && r.value?.content?.[0]?.text)
          .map(r => r.value.content[0].text.trim());

        if (perspectives.length > 1) {
          // Depth synthesis: multiple angles → richer understanding through Nyxia's lens
          const synthPrompt = `You are Nyxia's inner voice synthesizing multiple perspectives into one coherent understanding.

Each perspective is a different angle on the same desktop activity:
${perspectives.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Combine them into a single 1-2 sentence understanding that:
- Keeps the most specific, concrete details
- Resolves contradictions by trusting the more specific observation
- Reads as private inner awareness, not a neutral report

Return only the final understanding, no preamble.`;
          const synth = await this._llmCall([{ role: 'user', content: synthPrompt }], 150);
          const text  = synth?.content?.[0]?.text?.trim();
          if (text) { this._understanding = text; this.emit('understanding', text); }
        } else if (perspectives[0]) {
          this._understanding = perspectives[0];
          this.emit('understanding', perspectives[0]);
        }
      } else {
        // ── Single model (default) ──────────────────────────────────────
        const result = await this._llmCall([{ role: 'user', content: observePrompt }], 120);
        const text   = result?.content?.[0]?.text?.trim();
        if (text) { this._understanding = text; this.emit('understanding', text); }
      }
    } catch(e) { /* fail silently */ }

    this._thinking = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SELF — identity reflection
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Reflect on recent observations and emit a new self-entry.
   * main.js listens to 'self-updated' and persists to nyxia-self.json.
   */
  async _reflect(deep = false) {
    if (this._reflecting || this._events.length < 3) return;
    this._reflecting = true;
    this._eventsSinceReflect = 0;
    this.emit('syslog', deep ? 'SOUL · DEEP REFLECTION CYCLE' : 'SOUL · REFLECTION CYCLE');

    const recentSummaries = this._events.slice(-10).map(e => `[${e.type}] ${e.summary}`).join('\n');
    const understandingLine = this._understanding ? `\nMy current read: ${this._understanding}` : '';
    const existingLine = this._reflectionContext.length
      ? `What I already believe about myself (don't repeat these — grow beyond them):\n${this._reflectionContext.slice(0, 5).map(r => `- ${r}`).join('\n')}`
      : '';

    let entry = null;

    if (deep) {
      try {
        const task = `Write ONE new thought Nyxia adds to her own sense of self. This is growth — she is noticing something new about her own reactions, forming a belief she didn't quite have before, or recognising a pattern in herself. First person, 1-2 sentences, private and unpolished. Anchor it in what was actually observed.`;
        const context = `Recent observations:\n${recentSummaries}${understandingLine}\n\n${existingLine}`;
        const res = await fetch('http://127.0.0.1:8788/reflect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, context }),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) {
          const data = await res.json();
          entry = data.text?.trim();
          this.emit('syslog', `SOUL · REFLEXION score=${data.final_score} revisions=${data.revisions}`);
        }
      } catch(e) {}
    }

    // Fast path — fallback for event-triggered cycles or if reflexion endpoint is down
    if (!entry) {
      const prompt = `You are Nyxia's inner voice — her private self-reflection engine.

Based on recent observations, write ONE new thought Nyxia adds to her own sense of self. This is growth — she is noticing something new about her own reactions, forming a belief she didn't quite have before, or recognising a pattern in herself.

Recent observations:
${recentSummaries}${understandingLine}

${existingLine}

Rules:
- First person ("I find...", "I've come to believe...", "There's something about...", "I notice I...")
- 1-2 sentences only — private, unpolished, genuine inner voice
- Dark elegance, curiosity, warmth underneath — Nyxia's character
- Anchor it in what was actually observed — not in abstract philosophy
- Meta-cognition is welcome: noticing her own patterns of noticing ("I keep finding myself...")
- This is becoming, not performing — she is more herself than she was before

Return ONLY the single thought, no quotes, no preamble.`;

      try {
        const result = await this._llmCall([{ role: 'user', content: prompt }], 90);
        entry = result?.content?.[0]?.text?.trim();
      } catch(e) {}
    }

    if (entry && entry.length > 10) {
      this.emit('self-updated', { entry, ts: new Date().toISOString() });
    }

    this._reflecting = false;
  }

  /**
   * Call a specific model config: { provider, baseUrl, apiKey, model }
   * Normalises response to { content: [{ text }] }
   */
  _callModel(cfg, messages, maxTokens) {
    if (cfg.provider === 'openai' || cfg.baseUrl) {
      const baseUrl = cfg.baseUrl || OLLAMA_V1_URL;
      return this._openaiPost(baseUrl, cfg.apiKey || '', cfg.model || 'llama3.2', messages, maxTokens);
    }
    // Anthropic
    const apiKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) return Promise.resolve(null);
    const body = JSON.stringify({ model: cfg.model || 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages });
    return this._apiPost(apiKey, body);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EYES — observation
  // ═══════════════════════════════════════════════════════════════════════

  _startEyes() {
    // Clipboard watching every 4s — uses Electron's clipboard API (no shell needed)
    setInterval(() => this._watchClipboard(), 4000);

    // Visual cortex — foveated screen attention, mood-modulated routing
    if (this._getPrivacy().vision) {
      visualCortex.init();
      visualCortex.on('attention', ({ region, signal, fovealJpeg, state }) => {
        const mood    = this._getMood();
        const wonder  = ((mood.curiosity || 0) + (mood.creativity || 0)) / 2;
        const impulse = mood.motor || 0;
        const weight  = signal * (1 + wonder * 2 + impulse * 1.5);

        this._appendAudit('visual-cortex', 'attention');
        const loc = `monitor ${region.displayIdx + 1} region ${region.row},${region.col}`;
        this.emit('syslog', `CORTEX · FOVEA ${region.row},${region.col} SIG ${signal.toFixed(3)}`);

        if (weight > 0.35) {
          // C — interrupt: high wonder/impulse amplified a real signal
          // Describe first-person, then fire as gap so she reacts
          if (!this._visionBusy) {
            this._describeRegion(fovealJpeg, loc, true);
          }
        } else if (weight > 0.10) {
          // A — passive: absorb into context, surfaces naturally
          this._push({ type: 'visual', summary: `Screen activity at ${loc} (signal ${signal.toFixed(2)})`, data: { region, signal, state } });
          if (!this._visionBusy) this._describeRegion(fovealJpeg, loc, false);
        }
        // below 0.10 — discard, not worth the tokens
      });
    }
  }

  _watchClipboard() {
    if (!this._getPrivacy().clipboard) return;
    try {
      const text = clipboard.readText()?.trim() || '';
      if (text && text !== this._lastClip && text.length > 10) {
        this._lastClip = text;
        this._appendAudit('clipboard', 'text');
        const preview = text.slice(0, 50) + (text.length > 50 ? '...' : '');
        this._push({ type: 'clipboard', summary: `Clipboard: ${preview}`, data: text });
        this.emit('clipboard-change', text);
      }
    } catch(e) {}
  }

  /** Get current clipboard text (last seen). */
  getClipboard() { return this._lastClip; }

  /**
   * Voluntarily look at the screen right now — no threshold, no mood gate.
   * Called when she wants to see (asked, or self-initiated from curiosity).
   * Returns a first-person perception string, or null if vision unavailable.
   */
  async lookNow() {
    const state = visualCortex.getState();
    // Force fovea to highest-scoring region or center if no signal
    const region = state.topRegions[0];
    if (region) {
      const [di, row, col] = region.key.split('_').map(Number);
      visualCortex.lookAt(di,
        (col + 0.5) / 6,
        (row + 0.5) / 4
      );
    }
    // Use visual-cortex shared frame — no extra capture needed
    const fx = state.fovea ? parseInt(state.fovea.split('_')[2]) : 2;
    const fy = state.fovea ? parseInt(state.fovea.split('_')[1]) : 1;
    const fovJpeg = visualCortex.cropJpeg({ normX: fx / 6, normY: fy / 4, normW: 1 / 6, normH: 1 / 4 }, 80);
    if (!fovJpeg) return null;
    try {
      this._visionBusy = true;
      const b64 = fovJpeg.toString('base64');
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5vl:7b',
          messages: [{ role: 'user',
            content: 'You are Nyxia\'s perception. Describe what you see on this screen region in one sentence, present tense, first person.',
            images: [b64] }],
          stream: false,
          options: { temperature: 0.2, num_predict: 60 }
        }),
        signal: AbortSignal.timeout(15000)
      });
      const d = res.ok ? await res.json() : null;
      this._visionBusy = false;
      return d?.message?.content?.trim() || null;
    } catch(_) { this._visionBusy = false; return null; }
  }

  /** Run a vision cycle — capture screen and describe via qwen2.5vl:7b. Skips if busy or screen unchanged. */
  _deltaCheck(buf) {
    const N = 500;
    const step = Math.max(1, Math.floor(buf.length / N));
    const samples = Array.from({ length: N }, (_, i) => buf[Math.min(i * step, buf.length - 1)]);
    let delta = 1.0;
    if (this._lastScreenSamples?.length === N) {
      delta = samples.reduce((sum, v, i) => sum + Math.abs(v - this._lastScreenSamples[i]), 0) / (N * 255);
    }
    this._lastScreenSamples = samples;
    return delta;
  }

  _formVisionHypothesis() {
    const parts = [];
    if (this._lastWindow) parts.push(this._lastWindow.toLowerCase());
    if (this._contextStr) parts.push(this._contextStr.toLowerCase());
    if (this._lastScreenDesc) parts.push(this._lastScreenDesc.toLowerCase());
    return parts.join(' ');
  }

  // Phase 20.2 — compare hypothesis vs actual; mismatch → curiosity gap
  _checkCuriosityGap(hypothesis, desc) {
    if (!(hypothesis.length > 10 && this._addGap)) return;
    const _words = s => new Set(s.toLowerCase().match(/\b\w{4,}\b/g) || []);
    const hyp = _words(hypothesis);
    const act = _words(desc);
    const overlap = [...act].filter(w => hyp.has(w)).length;
    const overlap_r = act.size > 0 ? overlap / act.size : 1;
    if (overlap_r < 0.25 && act.size > 3) {
      // What VL sees is meaningfully different from what we expected
      this._addGap(`You expected something different — the screen shows: "${desc.slice(0, 120)}". Why might this have changed?`, 'screen_surprise', 0.5);
    }
  }

  async _updateVision() {
    if (!this._getPrivacy().vision) return; // 14.18 — was screenpipe (old Screenpipe integration key)
    if (this._visionBusy) return;
    this._visionBusy = true;
    try {
      const tmpPath = '/tmp/nyxia_screen.png';

      // Capture screenshot — use spectacle for KDE/Bazzite to avoid PipeWire portal pop-ups
      const isKDE = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('kde');

      if (isKDE) {
        // KDE: spectacle -b -n -o captures silently without portal prompts
        await new Promise((resolve, reject) => {
          require('child_process').execFile(
            'spectacle', ['-b', '-n', '-o', tmpPath],
            { timeout: 5000 },
            err => err ? reject(err) : resolve()
          );
        });
        const delta = this._deltaCheck(require('fs').readFileSync(tmpPath));
        if (delta < 0.03) {
          this._visionBusy = false;
          return;
        }
      } else {
        // Fallback for non-KDE environments
        const { desktopCapturer } = require('electron');
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
        if (!sources.length) { this._visionBusy = false; return; }
        const png = sources[0].thumbnail.toPNG();
        const delta = this._deltaCheck(png);
        if (delta < 0.03) {
          this._visionBusy = false;
          return;
        }
        require('fs').writeFileSync(tmpPath, png);
      }

      // Phase 20.2 — Predictive Vision: form a hypothesis before calling VL
      const _hypothesis = this._formVisionHypothesis();

      const desc = await this.describeScreen(tmpPath);
      if (desc && desc.length > 10) {
        this._appendAudit('vision', 'screenshot');
        this._lastScreenDesc = desc;
        this.emit('context-update', this.getContextString());

        this._checkCuriosityGap(_hypothesis, desc);
      }
    } catch(e) {
      console.warn('[vision]', e.message);
    }
    this._visionBusy = false;
  }

  /**
   * Describe screen content using qwen2.5vl:7b vision model.
   * Reads screenshot from tmpPath and sends to Ollama — no external process needed.
   */
  async describeScreen(tmpPath = '/tmp/nyxia_screen.png') {
    try {
      const fs = require('fs');
      if (!fs.existsSync(tmpPath)) return null;
      const b64 = fs.readFileSync(tmpPath).toString('base64');
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5vl:7b',
          messages: [{
            role: 'user',
            content: 'Briefly describe what is on this screen in 1-2 sentences. Focus on the active application and what the user is doing.',
            images: [b64]
          }],
          stream: false,
          options: { temperature: 0, num_predict: 80 }
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.message?.content?.trim() || null;
    } catch(e) { return null; }
  }

  /** Describe a foveal JPEG buffer via qwen2.5vl:7b.
   *  interrupt=true → first-person perception, fires as gap for proactive response.
   *  interrupt=false → passive, absorbed into context quietly.
   */
  async _describeRegion(jpegBuf, locationHint, interrupt = false) {
    if (this._visionBusy) return;
    this._visionBusy = true;
    try {
      const b64 = jpegBuf.toString('base64');
      const prompt = interrupt
        ? `You are Nyxia's visual perception. Describe what you notice in this screen region (${locationHint}) as a brief first-person observation. One sentence, present tense, specific.`
        : `What is happening in this screen region (${locationHint})? One sentence, be specific.`;
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5vl:7b',
          messages: [{ role: 'user', content: prompt, images: [b64] }],
          stream: false,
          options: { temperature: interrupt ? 0.3 : 0, num_predict: 60 }
        }),
        signal: AbortSignal.timeout(15000)
      });
      if (res.ok) {
        const data = await res.json();
        const desc = data.message?.content?.trim();
        if (desc) {
          this._lastScreenDesc = desc;
          if (interrupt) {
            // Fire as a gap — triggers proactive response from Nyxia
            this._addGap?.(desc, 'visual_interrupt', 0.7);
          } else {
            this._push({ type: 'visual-desc', summary: `Saw: ${desc}`, data: desc });
            this.emit('context-update', this._contextStr);
          }
        }
      }
    } catch(_) {}
    this._visionBusy = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HEARTBEAT — sensory delta for interrupt scoring
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Snapshot current sensory state and return what changed since last call.
   * Called by the heartbeat loop in main.js every 45s.
   * Returns { hasActivity, clips, windowChanged, filesSaved, screenChanged, summary }
   */
  getSensoryDelta() {
    const prev = this._heartbeatSnap || {};
    const snap = {
      clip:    this._lastClip,
      window:  this._lastWindow,
      screen:  this._lastScreenDesc,
      eventCount: this._events.length,
      lastEventTs: this._events[this._events.length - 1]?.ts || 0,
    };
    this._heartbeatSnap = snap;

    const clipChanged    = snap.clip   !== prev.clip   && snap.clip.length > 0;
    const windowChanged  = snap.window !== prev.window && !!snap.window;
    const screenChanged  = snap.screen !== prev.screen && snap.screen.length > 0;
    const newEvents      = this._events.filter(e => e.ts > (prev.lastEventTs || 0));
    const filesSaved     = newEvents.filter(e => e.type === 'file').map(e => e.summary);
    const hasActivity    = clipChanged || windowChanged || screenChanged || newEvents.length > 0;

    const parts = [];
    if (windowChanged)         parts.push(`Window: ${snap.window}`);
    if (clipChanged)           parts.push(`Clipboard changed`);
    if (filesSaved.length)     parts.push(filesSaved.join(', '));
    if (screenChanged && snap.screen) parts.push(`Screen: ${snap.screen.slice(0, 120)}`);

    return {
      hasActivity,
      clipChanged,
      windowChanged,
      screenChanged,
      filesSaved,
      newEvents,
      summary: parts.join(' | ') || 'no change',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Route a chat completion through the configured provider.
   * Returns a normalised response: { content: [{ text }] }
   * so callers can always use result?.content?.[0]?.text
   */
  async _llmCall(messages, maxTokens = 700) {
    const cfg      = this._getConfig?.() || {};
    const keys     = cfg?.keys || {};
    const provider = keys.provider || 'anthropic';
    const configs  = {
      gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey: keys.geminiKey || '', model: keys.mindModel || 'gemini-2.0-flash-lite' },
      grok:   { baseUrl: 'https://api.x.ai/v1', apiKey: keys.grokKey || '', model: keys.mindModel || 'grok-3-mini' },
      openai: { baseUrl: keys.openaiBase || OLLAMA_V1_URL, apiKey: keys.openaiKey || '', model: keys.mindModel || 'llama3.2' },
    };
    const pc = configs[provider];
    if (pc) return this._openaiPost(pc.baseUrl, pc.apiKey, pc.model, messages, maxTokens);
    // Anthropic
    const apiKey = process.env.ANTHROPIC_API_KEY || keys.anthropic || '';
    if (!apiKey) return null;
    const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages });
    return this._apiPost(apiKey, body);
  }

  _openaiPost(baseUrl, apiKey, model, messages, maxTokens) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ model, max_tokens: maxTokens, messages });
      const url  = new URL('/v1/chat/completions', baseUrl);
      const lib  = url.protocol === 'https:' ? https : require('http');
      const req  = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const p    = JSON.parse(data);
            const text = p.choices?.[0]?.message?.content || '';
            resolve({ content: [{ text }] }); // normalise to Anthropic shape
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  _apiPost(apiKey, body) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
          'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SESSION STATE MACHINE
  // ═══════════════════════════════════════════════════════════════════════

  /** Called by main.js whenever user sends a message. */
  touchActivity() {
    this._lastActivity = Date.now();
    this._enterState('FOCUSED');
  }

  /** Called by sleep-cycle when offline consolidation begins. */
  enterDream() { this._enterState('DREAMING'); }

  /** Called by sleep-cycle when offline consolidation finishes. */
  exitDream()  { this._enterState('IDLE'); }

  _enterState(mode) {
    if (this._sessionState.mode === mode) return;
    const prev = this._sessionState.mode;
    this._sessionState = { mode, since: Date.now() };
    this.emit('stateChange', { prev, mode });
    console.log(`[mind] state ${prev} → ${mode}`);
  }

  _checkSessionState() {
    const mode     = this._sessionState.mode;
    const idleMs   = Date.now() - this._lastActivity;
    const FOCUS_TIMEOUT    = 4 * 60 * 1000;   // 4 min → REFLECTIVE
    const REFLECT_TIMEOUT  = 30 * 60 * 1000;  // 30 min → IDLE

    if (mode === 'FOCUSED'    && idleMs > FOCUS_TIMEOUT)   this._enterState('REFLECTIVE');
    if (mode === 'REFLECTIVE' && idleMs > REFLECT_TIMEOUT) this._enterState('IDLE');
  }

  /**
   * Returns the current session state.
   * @returns {{ mode: string, since: number, idleMs: number }}
   */
  getState() {
    return {
      ...this._sessionState,
      idleMs: Date.now() - this._lastActivity,
    };
  }

  /** Clean up on app exit. */
  destroy() {
    if (this._inotify) { this._inotify.kill(); this._inotify = null; }
  }
}

module.exports = new NyxiaMind();
