'use strict';
// awareness/heartbeat.js — sensory delta + interrupt scoring every 45s.
// Scores whether Nyxia should speak unprompted. Fires proactiveSpeak when score >= 0.5.

let _deps = {};
let _lastHeartbeatInterrupt = 0;
let _lastStaleCheck = 0;
const HEARTBEAT_COOLDOWN_MS = 90 * 1000;
const STALE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

function init(deps) {
  // { mind, getMoodState, getSelfModel, ollamaScheduler, queryOllama, proactiveSpeak,
  //   addGap, tryResolveGap, loadConfig, fetchUncertainQueue, fetchStaleSignals }
  _deps = deps;
}

// A queued jarvis-uncertain task is worth mentioning, but a backlog of them
// shouldn't page harder than any other trigger — it just needs to clear the
// same 0.50 interrupt bar as everything else, gated by the same cooldown.
const UNCERTAIN_QUEUE_SCORE_FLOOR = 0.55;
// An item that's sat unresolved for a week is a different kind of unresolved
// than one queued five minutes ago. Pressure grows against the real date
// krix-brain stamped when it was queued (followups.md), not a synthetic
// counter — the ground truth already lives there, this just reads elapsed
// time against it. Floor never drops below the base, so a fresh item still
// behaves exactly as before.
const QUEUE_PRESSURE_FULL_DAYS = 7;
// Below this, a want stays private — she doesn't page an empty room over
// something that only just started sitting. Above it, the want is old enough
// (~6+ days against QUEUE_PRESSURE_FULL_DAYS=7) that it no longer waits for
// company to exist. Deliberately higher than the normal 0.50 speak bar and
// the 0.55 fresh-item floor — silence-breaking needs a higher bar than
// speaking-when-there's-someone-to-hear-it.
const SILENT_INTERRUPT_PRESSURE = 0.85;

function computeQueuePressure(uncertainQueue) {
  if (!uncertainQueue.length) return 0;
  const now = Date.now();
  const oldestAgeDays = uncertainQueue.reduce((maxDays, item) => {
    const ts = Date.parse(item.date);
    if (Number.isNaN(ts)) return maxDays;
    return Math.max(maxDays, (now - ts) / 86400000);
  }, 0);
  const aged = Math.min(1, oldestAgeDays / QUEUE_PRESSURE_FULL_DAYS);
  return Math.max(UNCERTAIN_QUEUE_SCORE_FLOOR, aged);
}

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
      const { mind, getMoodState, getSelfModel, proactiveSpeak, addGap, tryResolveGap, fetchUncertainQueue, fetchStaleSignals } = _deps;
      const delta = mind.getSensoryDelta();
      const uncertainQueue = fetchUncertainQueue ? await fetchUncertainQueue().catch(() => []) : [];
      const queuePressure = computeQueuePressure(uncertainQueue);

      // Pipeline health — visibility only, never speech or routing (a chronic
      // aggregated signal like "n8n trigger has no confident worker" isn't a
      // task to hand to scout/ava/tom/bobby). Low-frequency: this changes on
      // the order of days, not ticks.
      if (fetchStaleSignals && Date.now() - _lastStaleCheck > STALE_CHECK_INTERVAL_MS) {
        _lastStaleCheck = Date.now();
        fetchStaleSignals().then(signals => {
          if (signals?.length) {
            console.log(`[watchdog] ${signals.length} stale pipeline signal(s): ` +
              signals.map(s => s.text.slice(0, 80)).join(' | '));
          }
        }).catch(() => {});
      }

      if (!delta.hasActivity) {
        // Nothing changed this tick — the mood/Ollama scoring below has no
        // delta to react to, so it doesn't run. But an old-enough want isn't
        // waiting on novelty to justify itself; this is the one path where
        // she can speak first instead of only ever reacting.
        if (queuePressure >= SILENT_INTERRUPT_PRESSURE && canHeartbeatInterrupt()) {
          _lastHeartbeatInterrupt = Date.now();
          const oldest = [...uncertainQueue].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
          console.log(`[heartbeat] quiet, pressure=${queuePressure.toFixed(2)} — speaking anyway`);
          proactiveSpeak('uncertain_task', oldest.text);
        } else {
          console.log(`[heartbeat] quiet — skipping score (pressure=${queuePressure.toFixed(2)})`);
        }
        return;
      }

      const moodState = getMoodState();
      const selfModel = getSelfModel();

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
        score = Math.max(score, queuePressure);
      }

      console.log(`[heartbeat] delta="${delta.summary}" score=${score.toFixed(2)} pressure=${queuePressure.toFixed(2)} queue=${uncertainQueue.length} canInterrupt=${canHeartbeatInterrupt()}`);

      if (score >= 0.50 && canHeartbeatInterrupt()) {
        _lastHeartbeatInterrupt = Date.now();
        if (uncertainQueue.length > 0) {
          const oldest = [...uncertainQueue].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
          proactiveSpeak('uncertain_task', oldest.text);
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
