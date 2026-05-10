/**
 * shared-experience.js — Session event log with emotional weight
 *
 * Records significant moments during a session so sleep-cycle can
 * replay them with emotional context during consolidation.
 *
 * Each event: { ts, type, description, weight }
 *   weight: −1.0 (very negative) to +1.0 (very positive), 0 = neutral
 *
 * Kept in memory only — clears on app restart.
 * Sleep cycle consumes and clears after consolidation.
 */

'use strict';

const MAX_EVENTS = 60;

let _events = [];

/**
 * Log a significant moment.
 * @param {string} type        — category slug, e.g. 'project-win', 'frustration'
 * @param {string} description — human-readable note for LLM context
 * @param {number} weight      — emotional weight −1..+1 (default 0)
 */
function logEvent(type, description, weight = 0) {
  _events.push({ ts: Date.now(), type, description, weight: Math.max(-1, Math.min(1, weight)) });
  if (_events.length > MAX_EVENTS) _events.shift();
}

/** Return the most recent n events (default all). */
function getRecent(n = MAX_EVENTS) {
  return _events.slice(-n);
}

/** Return events whose |weight| >= threshold (default 0.3). */
function getSignificant(threshold = 0.3) {
  return _events.filter(e => Math.abs(e.weight) >= threshold);
}

/** Clear all events (called by sleep-cycle after consolidation). */
function clear() {
  _events = [];
}

/** Format events as a compact string for LLM context. */
function summarize(events = getSignificant()) {
  if (!events.length) return '';
  return events
    .map(e => {
      const ago   = Math.round((Date.now() - e.ts) / 60_000);
      const sign  = e.weight > 0 ? '+' : e.weight < 0 ? '−' : ' ';
      const score = Math.abs(e.weight).toFixed(1);
      return `[${ago}m ago, ${sign}${score}] ${e.type}: ${e.description}`;
    })
    .join('\n');
}

module.exports = { logEvent, getRecent, getSignificant, summarize, clear };
