'use strict';

/**
 * Shared SSE parsing and TTS sentence-chunking helpers.
 * Provider-specific logic (auth headers, body shape, token extraction) stays in main.js adapters.
 */

/**
 * Split an incoming HTTP chunk into complete SSE lines.
 * Returns completed lines and the updated (possibly incomplete) buffer tail.
 * @param {string} buf - accumulated buffer from previous chunk
 * @param {Buffer|string} chunk
 * @returns {{ lines: string[], buf: string }}
 */
function splitSseLines(buf, chunk) {
  buf += chunk.toString();
  const all = buf.split('\n');
  return { lines: all.slice(0, -1), buf: all[all.length - 1] };
}

/**
 * If textBuf contains a complete sentence, dispatch it to TTS and return the remainder.
 * Sentence boundary: `.`, `!`, `?`, or newline. Sentences shorter than 3 chars are held back.
 * @returns {{ textBuf: string, sentIdx: number }}
 */
function flushTtsSentence(textBuf, sentIdx, ttsChunk, elKey, voiceId, event) {
  const m = textBuf.match(/^(.*?[.!?\n])(\s*)([\s\S]*)$/);
  if (m && m[1].trim().length > 2) {
    ttsChunk(m[1].trim(), sentIdx, elKey, voiceId, event);
    return { textBuf: m[3], sentIdx: sentIdx + 1 };
  }
  return { textBuf, sentIdx };
}

/**
 * Standard end-of-stream handler shared by streamAnthropic and streamOpenAI.
 * Flushes the TTS buffer, emits stream-done, and runs post-processing callbacks.
 */
function finishStream({ textBuf, fullText, sentIdx, elKey, voiceId, event, messages,
                        ttsChunk, setIsStreaming, extractFactsAsync, notifyConversationTurn, detectGapsFromConversation }) {
  if (textBuf.trim().length > 2) ttsChunk(textBuf.trim(), sentIdx, elKey, voiceId, event);
  setIsStreaming(false);
  if (!event.sender.isDestroyed()) event.sender.send('stream-done', fullText);
  const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  if (lastUserMsg && fullText) {
    extractFactsAsync(lastUserMsg, fullText);
    notifyConversationTurn('assistant', fullText);
    detectGapsFromConversation(lastUserMsg, fullText);
    // Correction detection — if user corrects Nyxia, log a CORRECTED edge in graph
    const correctionPhrases = ["that's wrong", "you're wrong", "no, actually", "not quite", "incorrect", "that's not right", "that's incorrect"];
    if (correctionPhrases.some(p => lastUserMsg.toLowerCase().includes(p))) {
      const prevAssistant = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
      if (prevAssistant && prevAssistant.length > 10) {
        // Fire-and-forget: require graph-memory lazily to avoid circular dep issues
        try {
          const graphMemory = require('../graph-memory');
          graphMemory.writeCorrection(prevAssistant.slice(0, 300), lastUserMsg.slice(0, 300)).catch(() => {});
        } catch(_) {}
      }
    }
    // Opinion evolution log — detect when Nyxia expresses a belief/opinion
    const opinionTriggers = ["i think", "i believe", "i'd argue", "i suspect", "in my view", "i feel like", "my sense is"];
    if (fullText && opinionTriggers.some(t => fullText.toLowerCase().includes(t))) {
      // Extract first opinion sentence
      const _sentences = fullText.split(/(?<=[.!?])\s+/);
      const _opinionSent = _sentences.find(s => opinionTriggers.some(t => s.toLowerCase().includes(t)));
      if (_opinionSent && _opinionSent.length > 15) {
        try {
          const lanceMemory = require('../lance-memory');
          lanceMemory.writeOpinion(_opinionSent.trim().slice(0, 300)).catch(() => {});
        } catch(_) {}
      }
    }
    // Action-outcome tracking — log suggestions fire-and-forget
    try {
      const actionTracker = require('../action-tracker');
      if (fullText && fullText.length > 20) actionTracker.logAction(fullText);
    } catch(_) {}
    // Phase 20.5 — Causal inference: scan for causal language, update causal world model
    if (fullText && fullText.length > 20) {
      try {
        const _causal = require('../causal-model');
        // Match patterns: "X because Y", "X causes Y", "X leads to Y", "X results in Y", "if X then Y"
        const _causalRe = /([^.!?]{6,60}?)\s+(?:because|causes?|leads?\s+to|results?\s+in|makes?)\s+([^.!?]{6,60})/gi;
        let _m;
        while ((_m = _causalRe.exec(fullText)) !== null) {
          const cause = _m[1].trim().replace(/^(so|and|but|well|also)\s+/i, '').slice(0, 60);
          const effect = _m[2].trim().slice(0, 60);
          if (cause.length > 5 && effect.length > 5) {
            _causal.inferCausalRelation(cause, effect, true);
          }
        }
      } catch(_) {}
    }
  }
}

module.exports = { splitSseLines, flushTtsSentence, finishStream };
