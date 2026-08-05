'use strict';

/**
 * Intent Classifier — The Gatekeeper
 * Decides which Expert Brain should handle the user's request.
 * Returns { intent, confidence } — confidence < 0.55 falls back to LOGIC.
 */

const EXPERTS = {
  TEXT:   'nyxia-ft:latest',  // single text/voice + logic model — the only chat brain
  VISION: 'qwen2.5vl:7b',     // eyes — loaded on demand for images/screen only
};

// Keyword heuristics for confidence scoring
const SIGNALS = {
  LOGIC:  ['code', 'script', 'terminal', 'install', 'file', 'error', 'debug', 'run', 'bash', 'python', 'node', 'fix', 'build', 'function', 'class', 'module', 'import', 'git', 'command'],
  VISION: ['screen', 'see', 'look', 'visible', 'window', 'image', 'watching', 'show', 'display', 'what is on', 'can you see'],
  CHAT:   ['feel', 'think', 'love', 'miss', 'lonely', 'bored', 'talk', 'tell me', 'how are', 'story', 'opinion', 'what do you', 'do you like', 'babe', 'darling'],
};

function _scoreConfidence(text, intent) {
  const lc = text.toLowerCase();
  const intentSignals  = (SIGNALS[intent] || []).filter(kw => lc.includes(kw)).length;
  const totalSignals   = Object.values(SIGNALS).flat().filter(kw => lc.includes(kw)).length;

  if (totalSignals === 0) return 0.5; // no clear signal → medium confidence

  const dominance = intentSignals / totalSignals; // how much does chosen intent dominate?
  // short messages are inherently ambiguous
  const lengthPenalty = Math.min(1, text.trim().split(/\s+/).length / 8);
  return Math.min(0.55 + dominance * 0.4 + lengthPenalty * 0.05, 0.98);
}

/**
 * Classify the user's intent.
 * @param {string} text — user message
 * @returns {Promise<{ intent: 'CHAT'|'LOGIC'|'VISION', confidence: number }>}
 */
async function classifyIntent(text) {
  // Keyword heuristic only — no LLM round-trip. Both CHAT and LOGIC route to the
  // same text model (nyxia-ft), so the only decision that changes a model load is
  // VISION. A regex is instant and free; a 3B gatekeeper load was pure waste here.
  const lc = text.toLowerCase();
  let intent;
  if (SIGNALS.VISION.some(kw => lc.includes(kw)))      intent = 'VISION';
  else if (SIGNALS.LOGIC.some(kw => lc.includes(kw)))  intent = 'LOGIC';
  else intent = 'CHAT';

  const confidence = _scoreConfidence(text, intent);

  // Low-confidence guard: ambiguous → Prefrontal (LOGIC) is safest fallback
  if (confidence < 0.55 && intent !== 'LOGIC') {
    console.log(`[router] Low confidence (${confidence.toFixed(2)}) for ${intent} → falling back to LOGIC`);
    return { intent: 'LOGIC', confidence };
  }

  return { intent, confidence };
}

module.exports = { classifyIntent, EXPERTS };
