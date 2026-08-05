'use strict';
// awareness/heartbeat.js — sensory delta + interrupt scoring every 45s.
// Scores whether Nyxia should speak unprompted. Fires proactiveSpeak when score >= 0.5.

let _deps = {};
let _lastHeartbeatInterrupt = 0;
const HEARTBEAT_COOLDOWN_MS = 90 * 1000;

function init(deps) {
  // { mind, getMoodState, getSelfModel, ollamaScheduler, queryOllama, proactiveSpeak,
  //   addGap, tryResolveGap, loadConfig, fetchUncertainQueue }
  _deps = deps;
}

// A queued jarvis-uncertain task is worth mentioning, but a backlog of them
// shouldn't page harder than any other trigger — it just needs to clear the
// same 0.50 interrupt bar as everything else, gated by the same cooldown.
const UNCERTAIN_QUEUE_SCORE_FLOOR = 0.55;

function canHeartbeatInterrupt() {
  return Date.now() - _lastHeartbeatInterrupt > HEARTBEAT_COOLDOWN_MS;
}

async function _heartbeatQuery(prompt) {
  const { ollamaScheduler, queryOllama } = _deps;
  return (await ollamaScheduler.enqueue(1, () =>
    queryOllama('', prompt, { maxTokens: 10, timeoutMs: 6000 }), 'heartbeat')) || '0';
}

function startHeartbeat() {
  setInterval(async () => {
    try {
      const { mind, getMoodState, getSelfModel, proactiveSpeak, addGap, tryResolveGap, fetchUncertainQueue } = _deps;
      const moodState = getMoodState();
      const selfModel = getSelfModel();
      const delta = mind.getSensoryDelta();
      if (!delta.hasActivity) {
        console.log('[heartbeat] quiet — skipping score');
        return;
      }

      const uncertainQueue = fetchUncertainQueue ? await fetchUncertainQueue().catch(() => []) : [];

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
      let score   = Math.min(1, Math.max(0, parseFloat(raw) || 0));
      if (uncertainQueue.length > 0) {
        score = Math.max(score, UNCERTAIN_QUEUE_SCORE_FLOOR);
      }

      console.log(`[heartbeat] delta="${delta.summary}" score=${score.toFixed(2)} queue=${uncertainQueue.length} canInterrupt=${canHeartbeatInterrupt()}`);

      if (score >= 0.50 && canHeartbeatInterrupt()) {
        _lastHeartbeatInterrupt = Date.now();
        if (uncertainQueue.length > 0) {
          proactiveSpeak('uncertain_task', uncertainQueue[0].text);
        } else {
          proactiveSpeak('heartbeat', delta.summary);
        }
      }

      const wonder = ((moodState.curiosity || 0) + (moodState.creativity || 0)) / 2;
      if (wonder > 0.65 && !delta.hasActivity) {
        const perception = await mind.lookNow();
        if (perception) {
          addGap(perception, 'visual_wonder', 0.5);
          setTimeout(() => tryResolveGap(), 8000);
        }
      }
    } catch (e) {
      console.log('[heartbeat] error:', e.message);
    }
  }, 45 * 1000);
}

module.exports = { init, startHeartbeat, canHeartbeatInterrupt };
