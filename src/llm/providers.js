'use strict';
// llm/providers.js — OpenAI-compatible provider routing and The Council.
// Anthropic/Bridge adapter lives in llm/adapter.js.

const https = require('https');
const http  = require('http');

// Route to base URL + key for each OpenAI-compatible provider
function getProviderConfig(keys) {
  switch (keys.provider) {
    case 'gemini':   return { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey: keys.geminiKey   || '', model: keys.chatModel || 'gemini-2.0-flash' };
    case 'grok':     return { baseUrl: 'https://api.x.ai/v1',                                     apiKey: keys.grokKey     || '', model: keys.chatModel || 'grok-3-mini' };
    case 'groq':     return { baseUrl: 'https://api.groq.com/openai/v1',                           apiKey: keys.groqKey     || '', model: keys.chatModel || 'llama-3.3-70b-versatile' };
    case 'deepseek': return { baseUrl: 'https://api.deepseek.com/v1',                              apiKey: keys.deepseekKey || '', model: keys.chatModel || 'deepseek-chat' };
    case 'mistral':  return { baseUrl: 'https://api.mistral.ai/v1',                                apiKey: keys.mistralKey  || '', model: keys.chatModel || 'mistral-small-latest' };
    case 'kimi':     return { baseUrl: 'https://api.moonshot.cn/v1',                               apiKey: keys.kimiKey     || '', model: keys.chatModel || 'moonshot-v1-32k' };
    case 'openai':   return { baseUrl: keys.openaiBase || 'http://127.0.0.1:11434/v1',             apiKey: keys.openaiKey   || '', model: keys.chatModel || 'llama3.2' };
    default:         return null; // anthropic — handled by llm/adapter.js
  }
}

// All council members — every provider with a key, excluding Nyxia's own voice
function getCouncilConfigs(keys) {
  const voice = keys.provider || 'anthropic';
  const all = [
    { name: 'Gemini',  key: 'gemini',  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey: keys.geminiKey,  model: 'gemini-2.0-flash' },
    { name: 'Groq',    key: 'groq',    baseUrl: 'https://api.groq.com/openai/v1',                           apiKey: keys.groqKey,    model: 'llama-3.3-70b-versatile' },
    { name: 'Mistral', key: 'mistral', baseUrl: 'https://api.mistral.ai/v1',                                apiKey: keys.mistralKey, model: 'mistral-small-latest' },
  ];
  return all.filter(c => c.apiKey && c.key !== voice);
}

// Query one council member — non-streaming, 7s timeout, returns { name, text }
function queryCouncilMember(name, baseUrl, apiKey, model, messages) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ name, text: null }), 7000);
    // Join onto the base path — new URL('/v1/...', base) would discard base paths
    // like Groq's /openai/v1 or Gemini's /v1beta/openai/
    let base = baseUrl.replace(/\/+$/, '');
    if (new URL(base).pathname === '/') base += '/v1';
    const url   = new URL(base + '/chat/completions');
    const lib   = url.protocol === 'https:' ? https : http;
    const lastUser = messages.filter(m => m.role === 'user').slice(-1);
    const body  = JSON.stringify({
      model, max_tokens: 250, stream: false,
      messages: [
        { role: 'system', content: 'You are an advisor in a council. Give your honest perspective on the user\'s message in 2-3 sentences. Be direct and specific. No greetings.' },
        ...lastUser,
      ],
    });
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve({ name, text: JSON.parse(data).choices?.[0]?.message?.content || null }); }
        catch { resolve({ name, text: null }); }
      });
    });
    req.on('error', () => { clearTimeout(timer); resolve({ name, text: null }); });
    req.write(body);
    req.end();
  });
}

module.exports = { getProviderConfig, getCouncilConfigs, queryCouncilMember };
