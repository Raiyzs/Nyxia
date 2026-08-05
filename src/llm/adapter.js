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
    model:    'nyxia-ft',
    hostname: '127.0.0.1',
    path:     '/v1/chat/completions',
    family:   'openai',
  },
  // claude-bridge OAuth proxy — no API key needed, reads ~/.claude/.credentials.json
  bridge: {
    model:    'claude-sonnet-4-6',
    hostname: '127.0.0.1',
    port:     3456,
    path:     '/v1/messages',
    family:   'anthropic',
    secure:   false,
  },
  // vLLM ROCm — main PC (RX 9070 XT, 16GB VRAM)
  // Setup: pip install vllm --extra-index-url https://download.pytorch.org/whl/rocm6.2 --user
  // Run:   python -m vllm.entrypoints.openai.api_server \
  //          --model <path-or-hf-id> --enable-prefix-caching \
  //          --kv-cache-dtype fp8 --gpu-memory-utilization 0.88 --port 8100
  // One text brain (nyxia-ft) on 8100; Vision (qwen2.5vl) on 8102. Single text model
  // by design — heart/logic are the same finetune, not separate sector models.
  'vllm-text': {
    model:    'nyxia-ft',
    hostname: '127.0.0.1',
    path:     '/v1/chat/completions',
    port:     8100,
    family:   'openai',
  },
  'vllm-vision': {
    model:    'Qwen/Qwen2.5-VL-7B-Instruct',
    hostname: '127.0.0.1',
    path:     '/v1/chat/completions',
    port:     8102,
    family:   'openai',
  },
  // llama.cpp Vulkan backend — main PC (RX 9070 XT, 16GB VRAM), built 2026-07-24
  // (RDNA4 gfx1201, Vulkan not ROCm — ROCm's rocblas has no gfx1201 kernels yet).
  // Setup: ~/llama.cpp/build/bin/llama-server -m <gguf-path> -ngl 99 \
  //          --n-cpu-moe <N> --port 8090
  // Model: Qwen3-30B-A3B (MoE, 3B active) — fits fully in 16GB VRAM at Q4,
  // real measured ~145 tok/s on this VRAM class. See
  // ~/claude-projects/neuro-ai-research/research/phase2/ for the sizing research.
  'llamacpp-local': {
    model:    'nyxia-30b',
    hostname: '127.0.0.1',
    path:     '/v1/chat/completions',
    port:     8090,
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
  const port     = cfg?.llm?.port     || base.port || null; // null = use default (443/80)
  const family   = base.family;

  // Resolve API key: use explicit apiKey field, or fall back to known key slots
  let apiKey = cfg?.llm?.apiKey || '';
  if (!apiKey) {
    if (provider === 'anthropic')    apiKey = process.env.ANTHROPIC_API_KEY || cfg?.keys?.anthropic || '';
    else if (provider === 'openai' || provider === 'openai-realtime') apiKey = process.env.OPENAI_API_KEY || cfg?.keys?.openai || '';
    else if (provider === 'gemini')  apiKey = process.env.GEMINI_API_KEY || cfg?.keys?.gemini || cfg?.keys?.geminiKey || '';
    else if (provider === 'local')   apiKey = 'ollama';
  }

  // No API key for Anthropic → fall back to claude-bridge OAuth proxy
  let secure = base.secure !== false;
  let resolvedPort = port;
  if (provider === 'anthropic' && !apiKey) {
    const bridge = PROVIDER_DEFAULTS.bridge;
    return { provider: 'bridge', model, hostname: bridge.hostname, path: bridge.path,
             port: bridge.port, family: bridge.family, apiKey: '', secure: false };
  }

  return { provider, model, hostname, path: pathStr, port: resolvedPort, family, apiKey, secure };
}

/**
 * Build Anthropic-style request headers.
 */
function anthropicHeaders(apiKey, bodyLength) {
  const h = {
    'Content-Type':        'application/json',
    'anthropic-version':   '2023-06-01',
    'Content-Length':      bodyLength,
  };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
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
