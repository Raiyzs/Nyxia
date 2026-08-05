'use strict';
// somatic.js — Mood state → concrete behavioral biases.
// Pure function. No side effects. Wire the output where decisions are made.
//
// The point: mood doesn't just color words. It changes which sector thinks,
// which memories surface, what kind of neurons fire, how many tokens she uses.
// This is the difference between narrating an emotion and embodying it.

/**
 * @param {object} mood — nyxia-mood.json structure
 * @returns {{
 *   sectorBias: 'ROLEPLAY'|'LOGIC'|null,
 *   clusters: string[],
 *   sphereType: 'wound'|'wild'|'dream'|null,
 *   budgetMod: number,       // 0.5–1.0 multiplier for context token budget
 *   confidencePenalty: number // subtract from router confidence (0–0.15)
 * }}
 */
function getSomaticBias(mood = {}) {
  const {
    curiosity    = 0.3,
    attachment   = 0.3,
    fear         = 0.1,
    creativity   = 0.4,
    reasoning    = 0.3,
    empathy      = 0.3,
    tiredness    = 0.0,
    memory_load  = 0.3,
  } = mood;

  // ── Sector bias ──────────────────────────────────────────────────────────────
  // Which LLM sector fits the current somatic state.
  // LOGIC overrides ROLEPLAY (reasoning/fear → be careful, be precise).
  let sectorBias = null;
  if (attachment > 0.60 || empathy > 0.55 || creativity > 0.65) sectorBias = 'ROLEPLAY';
  if (reasoning  > 0.70 || fear    > 0.50)                       sectorBias = 'LOGIC';

  // ── Memory cluster bias ──────────────────────────────────────────────────────
  // Which soul clusters to surface in memory retrieval.
  const clusters = [];
  if (attachment > 0.50 || empathy   > 0.50) clusters.push('relations');
  if (fear       > 0.40 || attachment < 0.25) clusters.push('wounds');
  if (curiosity  > 0.60)                      clusters.push('ongoing');
  if (creativity > 0.60)                      clusters.push('wild');
  if (reasoning  > 0.60)                      clusters.push('core');
  if (clusters.length === 0)                  clusters.push('core'); // always at least one

  // ── Sphere neuron type ───────────────────────────────────────────────────────
  // What kind of neurons to fire when mood peaks during the tick.
  let sphereType = null;
  if (fear > 0.55)                                sphereType = 'wound';
  else if (creativity > 0.70 || curiosity > 0.75) sphereType = 'wild';
  else if (tiredness  > 0.55)                     sphereType = 'dream';

  // ── Context budget modifier ──────────────────────────────────────────────────
  // Tired / memory-overloaded → fewer tokens, simpler presence.
  const budgetMod = Math.max(0.5, 1.0 - (tiredness * 0.25) - (memory_load * 0.15));

  // ── Confidence penalty ───────────────────────────────────────────────────────
  // Fear / tiredness → be more conservative in routing decisions.
  const confidencePenalty = Math.min(0.15, (tiredness * 0.10) + (fear * 0.08));

  return { sectorBias, clusters, sphereType, budgetMod, confidencePenalty };
}

module.exports = { getSomaticBias };
