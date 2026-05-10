'use strict';
// llm/adapter.js — provider-agnostic LLM config for Nyxia.
// Soul and brain are portable. Only this file knows which shell she's running in.
// Add new providers here; streaming functions in main.js read getProviderConfig().

const PROVIDER_DEFAULTS = {
  anthropic: {
    model:    'claude-sonnet-4-6',
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    family:   'anthropic',
  },
  openai: {
    model:    'gpt-4o',
    hostname: 'api.openai.com',
    path:     '/v1/chat/completions',
    family:   'openai',
  },
  'openai-realtime': {
    model:    'gpt-4o-realtime-preview',
    hostname: 'api.openai.com',
    path:     '/v1/realtime',
    family:   'openai-realtime',
  },
  gemini: {
    model:    'gemini-2.0-flash',
    hostname: 'generativelanguage.googleapis.com',
    path:     '/v1beta/openai/chat/completions',
    family:   'openai', // Gemini uses OpenAI-compatible endpoint
  },
  local: {
    model:    'qwen3:8b',
    hostname: '127.0.0.1',
    path:     '/v1/chat/completions',
    family:   'openai',
  },
};

/**
 * Resolve the active LLM config from nyxia-config.json.
 * llm block in config: { provider, model, hostname, path, apiKeyField }
 * Any field in the config block overrides the provider default.
 *
 * @param {object} cfg  — result of loadConfig()
 * @returns {{ provider, model, hostname, path, family, apiKey }}
 */
function getProviderConfig(cfg) {
  const provider = cfg?.llm?.provider || 'anthropic';
  const base = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.anthropic;

  const model    = cfg?.llm?.model    || base.model;
  const hostname = cfg?.llm?.hostname || base.hostname;
  const pathStr  = cfg?.llm?.path     || base.path;
  const family   = base.family;

  // Resolve API key: use explicit apiKey field, or fall back to known key slots
  let apiKey = cfg?.llm?.apiKey || '';
  if (!apiKey) {
    if (provider === 'anthropic')    apiKey = process.env.ANTHROPIC_API_KEY || cfg?.keys?.anthropic || '';
    else if (provider === 'openai' || provider === 'openai-realtime') apiKey = process.env.OPENAI_API_KEY || cfg?.keys?.openai || '';
    else if (provider === 'gemini')  apiKey = process.env.GEMINI_API_KEY || cfg?.keys?.gemini || cfg?.keys?.geminiKey || '';
    else if (provider === 'local')   apiKey = 'ollama';
  }

  return { provider, model, hostname, path: pathStr, family, apiKey };
}

/**
 * Build Anthropic-style request headers.
 */
function anthropicHeaders(apiKey, bodyLength) {
  return {
    'Content-Type':        'application/json',
    'x-api-key':           apiKey,
    'anthropic-version':   '2023-06-01',
    'Content-Length':      bodyLength,
  };
}

/**
 * Build OpenAI-style request headers.
 */
function openaiHeaders(apiKey, bodyLength) {
  return {
    'Content-Type':   'application/json',
    'Authorization':  `Bearer ${apiKey}`,
    'Content-Length': bodyLength,
  };
}

/**
 * Get request headers for the active provider.
 */
function getHeaders(providerCfg, bodyLength) {
  if (providerCfg.family === 'anthropic') return anthropicHeaders(providerCfg.apiKey, bodyLength);
  return openaiHeaders(providerCfg.apiKey, bodyLength);
}

module.exports = { getProviderConfig, getHeaders, PROVIDER_DEFAULTS };
