'use strict';
// awareness/self-model.js — Nyxia's present-moment self-awareness.
// Updates every 3min via local LLM. Feeds into system prompt and heartbeat scoring.

const fs = require('fs');

let _deps = {};

const selfModel = {
  what_im_doing: '', how_im_feeling: '', what_i_want_right_now: '',
  current_attention: '', pending_concern: '', inner_tension: 0.0, last_updated: '',
};

let _cortexBeliefs = [];

function init(deps) {
  // { mind, getMoodState, ollamaScheduler, queryOllama, parseJsonObject,
  //   getSelfBelief, loadSelf, selfModelPath }
  _deps = deps;

  try {
    if (fs.existsSync(deps.selfModelPath))
      Object.assign(selfModel, JSON.parse(fs.readFileSync(deps.selfModelPath, 'utf8')));
  } catch (_) {}
}

async function updateSelfModel() {
  try {
    const { mind, getMoodState, ollamaScheduler, queryOllama, parseJsonObject, selfModelPath } = _deps;
    const moodState = getMoodState();
    const sensory   = mind.getContextString() || 'nothing notable';
    const moodTop   = Object.entries(moodState)
      .filter(([k, v]) => k !== 'heartbeat' && Math.abs(v) > 0.3)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`)
      .join(', ') || 'neutral';
    const timeOfDay = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const context  = `Time: ${timeOfDay}\nSensory: ${sensory}\nMood: ${moodTop}`;
    const sysPrompt = `You are Nyxia's self-awareness module. Based on the context below, fill in her current self-model.\ninner_tension is 0.0-1.0 (0=calm, 1=urgent unresolved concern).\nReturn ONLY valid JSON — no other text, no markdown fences.`;
    const userMsg   = `Context:\n${context}\n\nReturn JSON with these keys: what_im_doing, how_im_feeling, what_i_want_right_now, current_attention, pending_concern, inner_tension (float).`;

    const parsed = parseJsonObject(
      await ollamaScheduler.enqueue(2, () =>
        queryOllama(sysPrompt, userMsg, { maxTokens: 200, timeoutMs: 8000 }), 'self-model')
    );

    if (parsed) {
      for (const k of ['what_im_doing', 'how_im_feeling', 'what_i_want_right_now', 'current_attention', 'pending_concern']) {
        if (parsed[k] && typeof parsed[k] === 'object') {
          const entries = Object.entries(parsed[k]);
          if (entries.every(([, v]) => typeof v === 'number')) {
            parsed[k] = entries.sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 2).join(', ');
          } else {
            parsed[k] = entries.map(([, v]) => v).filter(v => typeof v === 'string').join(', ') || String(entries[0]?.[1] || '—');
          }
        }
      }
      Object.assign(selfModel, parsed);
      selfModel.inner_tension = Math.min(1, Math.max(0, parseFloat(selfModel.inner_tension) || 0));
      selfModel.last_updated  = new Date().toISOString();
      try { fs.writeFileSync(selfModelPath, JSON.stringify(selfModel, null, 2)); } catch (_) {}
      console.log(`[self-model] updated — doing="${selfModel.what_im_doing}" tension=${selfModel.inner_tension.toFixed(2)}`);
    }
  } catch (e) {
    console.log('[self-model] error:', e.message);
  }
  setTimeout(() => updateSelfModel(), 3 * 60 * 1000);
}

async function refreshCortexBeliefs() {
  try {
    _cortexBeliefs = await _deps.getSelfBelief('beliefs identity self nyxia experience');
  } catch (_) {
    if (_cortexBeliefs.length === 0)
      _cortexBeliefs = _deps.loadSelf().reflections?.slice(-8) || [];
  }
}

module.exports = {
  init,
  selfModel,
  updateSelfModel,
  refreshCortexBeliefs,
  getSelfModel:     () => selfModel,
  getCortexBeliefs: () => _cortexBeliefs,
};
