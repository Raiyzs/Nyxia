'use strict';
/**
 * visual-cortex.js — Nyxia's eyes (Bazzite/KDE native)
 *
 * Single capture owner for the whole app. Uses spectacle on KDE (no portal
 * dialogs, no Wayland permission requests) and falls back to desktopCapturer
 * only on non-KDE systems. All consumers read lastFrameJpeg instead of
 * calling desktopCapturer themselves.
 *
 * Emits:
 *   'attention' { region, signal, fovealJpeg, state }  — threshold crossed
 *   'saccade'   { from, to }                           — fovea jumped
 */

const { EventEmitter }  = require('events');
const { nativeImage, screen } = require('electron');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');

const COLS            = 6;
const ROWS            = 4;
const SCAN_INTERVAL   = 800;    // ms — spectacle takes ~200-400ms, so 800 is safe
const THUMB           = { width: 960, height: 540 };
const SIGNAL_DECAY    = 0.82;
const ACCUM_DECAY     = 0.90;
const ACCUM_THRESHOLD = 14;
const FOVEAL_WEIGHT   = 6;
const HEAD_LERP       = 0.04;
const TMP_PATH        = '/tmp/nyxia_vcortex.png';

class VisualCortex extends EventEmitter {
  constructor() {
    super();
    this._displays     = [];
    this._regions      = [];
    this._scores       = {};
    this._accumulator  = 0;
    this._fovea        = null;
    this._head         = { displayIdx: 0, cx: 0.5, cy: 0.5, strength: 0 };
    this._prevBuf      = null;   // BGRA bitmap of last thumbnail (peripheral diff)
    this._prevFovBuf   = null;
    this._prevFovKey   = null;
    this._timer        = null;
    this._busy         = false;
    this._useSpectacle = false;

    // Shared frame — mind.js reads these instead of calling getSources
    this.lastFrameJpeg = null;   // Buffer — JPEG of last full thumbnail
    this.lastFrameTime = 0;      // Date.now() of last capture
    this._lastThumb    = null;   // NativeImage — kept for cropJpeg()
  }

  /**
   * Crop a foveal region from the most recent captured frame.
   * Returns a JPEG Buffer, or null if no frame captured yet or frame is stale.
   * region: { normX, normY, normW, normH } in 0-1 normalized coords.
   * maxAge: reject frames older than this many ms (default 3000).
   */
  cropJpeg(region, quality = 80, maxAge = 3000) {
    if (!this._lastThumb || !this.lastFrameTime) return null;
    if (Date.now() - this.lastFrameTime > maxAge) return null;
    try {
      const cropRect = {
        x:      Math.floor((region.normX || 0) * THUMB.width),
        y:      Math.floor((region.normY || 0) * THUMB.height),
        width:  Math.ceil((region.normW || 1 / COLS) * THUMB.width),
        height: Math.ceil((region.normH || 1 / ROWS) * THUMB.height)
      };
      return this._lastThumb.crop(cropRect).toJPEG(quality);
    } catch (_) { return null; }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  init() {
    try {
      execFileSync('which', ['spectacle'], { stdio: 'ignore' });
      this._useSpectacle = true;
      console.log('[visual-cortex] backend: spectacle (KDE native, no portal)');
    } catch (_) {
      this._useSpectacle = false;
      console.log('[visual-cortex] backend: desktopCapturer (fallback)');
    }

    this._displays = screen.getAllDisplays();
    this._buildRegions();
    this._timer = setInterval(() => this._scan(), SCAN_INTERVAL);
    this._scan();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  lookAt(displayIdx = 0, normX = 0.5, normY = 0.5) {
    this._head = { displayIdx, cx: normX, cy: normY, strength: 0.9 };
  }

  resetAttention() {
    this._head.strength = 0;
    this._accumulator   = 0;
    this._scores        = Object.fromEntries(this._regions.map(r => [r.key, 0]));
  }

  getState() {
    const top = Object.entries(this._scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, score]) => ({ key, score: +score.toFixed(3) }));
    return {
      fovea:       this._fovea,
      head:        this._head,
      accumulator: +this._accumulator.toFixed(2),
      topRegions:  top,
      displays:    this._displays.length,
      backend:     this._useSpectacle ? 'spectacle' : 'desktopCapturer',
      frameAge:    this.lastFrameTime ? Date.now() - this.lastFrameTime : null
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _buildRegions() {
    this._regions = [];
    this._scores  = {};
    // Spectacle composites all monitors into one image — treat as single display
    const displayCount = this._useSpectacle ? 1 : this._displays.length;
    for (let di = 0; di < displayCount; di++) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const key = `${di}_${r}_${c}`;
          this._regions.push({ key, displayIdx: di, row: r, col: c,
            normX: c / COLS, normY: r / ROWS, normW: 1 / COLS, normH: 1 / ROWS });
          this._scores[key] = 0;
        }
      }
    }
  }

  /** Capture screen once via spectacle, return NativeImage at THUMB size. */
  async _captureSpectacle() {
    await new Promise((resolve, reject) =>
      execFile('spectacle', ['-b', '-n', '-o', TMP_PATH], { timeout: 5000 },
        err => err ? reject(err) : resolve())
    );
    return nativeImage.createFromPath(TMP_PATH)
      .resize({ width: THUMB.width, height: THUMB.height, quality: 'good' });
  }

  async _scan() {
    if (this._busy) return;
    this._busy = true;
    try {
      if (this._useSpectacle) {
        await this._scanSpectacle();
      } else {
        await this._scanDesktopCapturer();
      }
    } catch (_) {}
    this._busy = false;
  }

  async _scanSpectacle() {
    const thumb = await this._captureSpectacle();
    const buf   = thumb.toBitmap(); // BGRA

    // Update shared frame for consumers
    this._lastThumb    = thumb;
    this.lastFrameJpeg = thumb.toJPEG(72);
    this.lastFrameTime = Date.now();

    // ── Peripheral diff across all regions ──────────────────────────────────
    if (this._prevBuf && this._prevBuf.length === buf.length) {
      for (const region of this._regions) {
        const delta = this._regionDiff(buf, this._prevBuf, THUMB.width, THUMB.height, region);
        this._scores[region.key] = this._scores[region.key] * SIGNAL_DECAY + delta;
      }
    }
    this._prevBuf = buf;

    this._accumulator *= ACCUM_DECAY;

    // ── Saccade ─────────────────────────────────────────────────────────────
    const best = this._saccade();
    if (!best) return;

    const prevFovea = this._fovea;
    this._fovea = best.key;
    if (prevFovea && prevFovea !== best.key) this.emit('saccade', { from: prevFovea, to: best.key });

    // ── Foveal crop + diff ───────────────────────────────────────────────────
    const cropRect = {
      x:      Math.floor(best.normX * THUMB.width),
      y:      Math.floor(best.normY * THUMB.height),
      width:  Math.ceil(best.normW * THUMB.width),
      height: Math.ceil(best.normH * THUMB.height)
    };
    const cropped = thumb.crop(cropRect);
    const fovBuf  = cropped.toBitmap();

    if (this._prevFovBuf && this._prevFovKey === best.key &&
        this._prevFovBuf.length === fovBuf.length) {
      let diff = 0;
      for (let i = 0; i < fovBuf.length; i += 4) {
        diff += Math.abs(fovBuf[i]   - this._prevFovBuf[i])   +
                Math.abs(fovBuf[i+1] - this._prevFovBuf[i+1]) +
                Math.abs(fovBuf[i+2] - this._prevFovBuf[i+2]);
      }
      const signal = diff / (fovBuf.length / 4) / 255;
      this._accumulator += signal * FOVEAL_WEIGHT;

      if (this._accumulator >= ACCUM_THRESHOLD) {
        this._accumulator = 0;
        this.emit('attention', {
          region:     best,
          signal:     +signal.toFixed(4),
          fovealJpeg: cropped.toJPEG(72),
          state:      this.getState()
        });
      }
    }
    this._prevFovBuf = fovBuf;
    this._prevFovKey = best.key;
    this._driftHead(best);
  }

  async _scanDesktopCapturer() {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: THUMB });
    if (!sources.length) return;

    // Update shared frame
    this._lastThumb    = sources[0].thumbnail;
    this.lastFrameJpeg = sources[0].thumbnail.toJPEG(72);
    this.lastFrameTime = Date.now();

    // Peripheral pass: per-display diff
    sources.forEach((src, di) => {
      const buf  = src.thumbnail.toBitmap();
      const prev = di === 0 ? this._prevBuf : null; // multi-display: use prevBuf for first only
      if (prev && prev.length === buf.length) {
        for (const region of this._regions) {
          if (region.displayIdx !== di) continue;
          const delta = this._regionDiff(buf, prev, THUMB.width, THUMB.height, region);
          this._scores[region.key] = this._scores[region.key] * SIGNAL_DECAY + delta;
        }
      }
      if (di === 0) this._prevBuf = buf;
    });

    this._accumulator *= ACCUM_DECAY;
    const best = this._saccade();
    if (!best) return;

    const prevFovea = this._fovea;
    this._fovea = best.key;
    if (prevFovea && prevFovea !== best.key) this.emit('saccade', { from: prevFovea, to: best.key });

    const src = sources[best.displayIdx] || sources[0];
    if (!src) return;

    const cropRect = {
      x:      Math.floor(best.normX * THUMB.width),
      y:      Math.floor(best.normY * THUMB.height),
      width:  Math.ceil(best.normW * THUMB.width),
      height: Math.ceil(best.normH * THUMB.height)
    };
    const cropped = src.thumbnail.crop(cropRect);
    const fovBuf  = cropped.toBitmap();

    if (this._prevFovBuf && this._prevFovKey === best.key &&
        this._prevFovBuf.length === fovBuf.length) {
      let diff = 0;
      for (let i = 0; i < fovBuf.length; i += 4) {
        diff += Math.abs(fovBuf[i]   - this._prevFovBuf[i])   +
                Math.abs(fovBuf[i+1] - this._prevFovBuf[i+1]) +
                Math.abs(fovBuf[i+2] - this._prevFovBuf[i+2]);
      }
      const signal = diff / (fovBuf.length / 4) / 255;
      this._accumulator += signal * FOVEAL_WEIGHT;

      if (this._accumulator >= ACCUM_THRESHOLD) {
        this._accumulator = 0;
        this.emit('attention', {
          region:     best,
          signal:     +signal.toFixed(4),
          fovealJpeg: cropped.toJPEG(72),
          state:      this.getState()
        });
      }
    }
    this._prevFovBuf = fovBuf;
    this._prevFovKey = best.key;
    this._driftHead(best);
  }

  _regionDiff(buf, prev, W, H, region) {
    const x0 = Math.floor(region.normX * W);
    const y0 = Math.floor(region.normY * H);
    const x1 = Math.floor((region.normX + region.normW) * W);
    const y1 = Math.floor((region.normY + region.normH) * H);
    let diff = 0, n = 0;
    for (let y = y0; y < y1; y += 3) {
      for (let x = x0; x < x1; x += 3) {
        const i = (y * W + x) * 4;
        diff += Math.abs(buf[i]   - prev[i])   +
                Math.abs(buf[i+1] - prev[i+1]) +
                Math.abs(buf[i+2] - prev[i+2]);
        n++;
      }
    }
    return n > 0 ? diff / n / 255 : 0;
  }

  _saccade() {
    let best = null, bestScore = -1;
    for (const region of this._regions) {
      let score = this._scores[region.key];
      if (score < 0.001) continue;
      if (region.displayIdx === this._head.displayIdx && this._head.strength > 0) {
        const cx   = region.normX + region.normW / 2;
        const cy   = region.normY + region.normH / 2;
        const dist = Math.hypot(cx - this._head.cx, cy - this._head.cy);
        score *= 1 + this._head.strength * (1 - Math.min(1, dist * 2));
      }
      if (score > bestScore) { bestScore = score; best = region; }
    }
    return best;
  }

  _driftHead(region) {
    const cx = region.normX + region.normW / 2;
    const cy = region.normY + region.normH / 2;
    this._head.cx         = this._head.cx * (1 - HEAD_LERP) + cx * HEAD_LERP;
    this._head.cy         = this._head.cy * (1 - HEAD_LERP) + cy * HEAD_LERP;
    this._head.displayIdx = region.displayIdx;
    this._head.strength   = Math.min(0.6, this._head.strength + 0.005);
  }
}

module.exports = new VisualCortex();
