// Shared Ollama HTTP client — used by awareness-loop, curiosity-gaps, other-model, sleep-cycle.
// Single implementation so fixes/changes only happen here.
'use strict';

const http = require('http');

/**
 * Send a chat completion request to local Ollama.
 * @param {string} sys
 * @param {string} user
 * @param {{ model?, maxTokens?, timeoutMs?, forceUnload? }} opts
 * @returns {Promise<string|null>}
 */
function queryOllama(sys, user, { model = 'llama3.2:3b', maxTokens = 120, timeoutMs = 8000, forceUnload = false, cpuOnly = false } = {}) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model, stream: false, max_tokens: maxTokens,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      // VRAM Management: keep_alive: 0 forces model to unload after completion
      ...(forceUnload && { options: { keep_alive: 0 } }),
      ...(cpuOnly     && { options: { num_gpu: 0 } }),
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 11434,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || null); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

/** Extract a JSON object from an LLM response that may contain surrounding prose. */
function parseJsonObject(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch (_) { return null; }
}

/** Extract a JSON array from an LLM response that may contain surrounding prose. */
function parseJsonArray(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? ''); } catch (_) { return null; }
}

module.exports = { queryOllama, parseJsonObject, parseJsonArray };
