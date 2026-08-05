'use strict';

/**
 * context-layer.js — Single source of truth for all awareness context
 *
 * Awareness modules WRITE to this store. buildSystemPrompt() READS from it.
 * Replaces fragmented getters injected individually into prompt-builder.
 *
 * Slots and priority weights (higher = include first when trimming):
 *   self     (9) — present-moment self-model
 *   mood     (8) — emotional/physiological state
 *   other    (7) — theory of mind for Kristian
 *   memory   (6) — LanceDB reflections
 *   body     (5) — interoception (GPU/CPU/fatigue)
 *   gaps     (4) — curiosity gaps
 *   graph    (3) — Kùzu cross-memory connections
 *   scene    (2) — screen content / vision description
 *
 * Max-age per slot in ms — stale data is excluded from buildSystemPrompt.
 */

const MAX_AGE = {
  self:   5  * 60_000,  // 5 min — self-model updates every 3min
  mood:   3  * 60_000,  // 3 min — mood decays every 2min
  other:  10 * 60_000,  // 10 min — theory-of-mind infers every 4 turns
  memory: 15 * 60_000,  // 15 min — reflections refresh after each write
  body:   2  * 60_000,  // 2 min — interoception polls every 30s
  gaps:   30 * 60_000,  // 30 min — gaps are long-lived
  graph:  30 * 60_000,  // 30 min — graph rarely changes
  scene:  3  * 60_000,  // 3 min — screen updates every 90s
};

const PRIORITY = { self: 9, mood: 8, other: 7, memory: 6, body: 5, gaps: 4, graph: 3, scene: 2 };

let _store = {};
let _timestamps = {};

/**
 * setContext(slot, data) — write from any awareness module.
 * @param {string} slot — one of the defined slot names
 * @param {*}      data — any serializable value
 */
function setContext(slot, data) {
  _store[slot] = data;
  _timestamps[slot] = Date.now();
}

/**
 * getSlot(slot) — returns data for slot, or null if stale/absent.
 * @param {string} slot
 * @param {boolean} [allowStale=false] — bypass max-age check
 */
function getSlot(slot, allowStale = false) {
  if (!_store.hasOwnProperty(slot)) return null;
  if (!allowStale) {
    const age = Date.now() - (_timestamps[slot] || 0);
    if (MAX_AGE[slot] && age > MAX_AGE[slot]) return null;
  }
  return _store[slot];
}

/**
 * getContext() — returns all non-stale slots, sorted by priority (high first).
 */
function getContext() {
  return Object.keys(PRIORITY)
    .sort((a, b) => PRIORITY[b] - PRIORITY[a])
    .reduce((out, slot) => {
      const val = getSlot(slot);
      if (val !== null) out[slot] = val;
      return out;
    }, {});
}

/**
 * getContextAge(slot) — ms since last update, Infinity if never set.
 */
function getContextAge(slot) {
  return _timestamps[slot] ? Date.now() - _timestamps[slot] : Infinity;
}

// Soft char budget per slot when using getBudgetedContext()
const SLOT_BUDGETS = {
  self:   500,
  mood:   200,
  other:  300,
  memory: 900,
  body:   180,
  gaps:   250,
  graph:  600,
  scene:  400,
};

function _truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const s    = String(text).slice(0, maxChars);
  const last = Math.max(s.lastIndexOf('. '), s.lastIndexOf('\n'));
  return (last > maxChars * 0.5 ? s.slice(0, last + 1) : s).trimEnd();
}

/**
 * getBudgetedContext(totalBudget, moodState?) — returns all non-stale slots,
 * each capped to its slot budget, total capped at totalBudget chars.
 * Slots are included in priority order (high first).
 * moodState applies somatic budgetMod — tired/overloaded reduces total budget.
 *
 * @param {number} totalBudget — max total chars (default 3000)
 * @param {object} [moodState] — optional mood state for somatic budget scaling
 * @returns {{ slots: object, totalChars: number, truncated: boolean }}
 */
function getBudgetedContext(totalBudget = 3000, moodState = null) {
  if (moodState) {
    try {
      const { getSomaticBias } = require('./somatic');
      const { budgetMod } = getSomaticBias(moodState);
      totalBudget = Math.floor(totalBudget * budgetMod);
    } catch(_) {}
  }
  const priorityOrder = Object.keys(PRIORITY).sort((a, b) => PRIORITY[b] - PRIORITY[a]);
  const slots  = {};
  let   used   = 0;
  let   truncated = false;

  for (const slot of priorityOrder) {
    const val = getSlot(slot);
    if (val === null) continue;

    const text    = typeof val === 'string' ? val : JSON.stringify(val);
    const cap     = Math.min(SLOT_BUDGETS[slot] ?? 300, totalBudget - used);
    if (cap <= 0) { truncated = true; break; }

    const chunk = _truncate(text, cap);
    if (chunk) {
      slots[slot] = chunk;
      used += chunk.length;
      if (chunk.length < text.length) truncated = true;
    }
  }

  return { slots, totalChars: used, truncated };
}

module.exports = { setContext, getSlot, getContext, getContextAge, getBudgetedContext, PRIORITY, SLOT_BUDGETS };
