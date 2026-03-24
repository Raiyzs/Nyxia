// api-server.js — Phase 5.1/5.2: Local HTTP API + PWA server
// POST /message → { text, history? } → { response, mode }
// GET  /health  → { status: 'ok' }
// GET  /        → serves pwa/index.html (PWA thin client)
// Listens on 0.0.0.0:7337 (home network reachable)
// No auth — local network only. Never expose to internet.

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { browserExecute } = require('./browser');

const PWA_DIR = path.join(__dirname, '..', 'pwa');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.css':  'text/css',
};

function serveStatic(req, res) {
  let filePath = path.join(PWA_DIR, req.url === '/' ? 'index.html' : req.url);
  // Safety: keep within PWA_DIR
  if (!filePath.startsWith(PWA_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

let _server = null;
const _sseClients = new Set();

function broadcastSSE(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(data); } catch(_) { _sseClients.delete(res); }
  }
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Non-streaming Anthropic call — returns full text string
function callAnthropic(messages, systemPrompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1000, stream: false,
      system: systemPrompt, messages,
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          resolve(j.content?.[0]?.text || '');
        } catch(e) { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Non-streaming OpenAI-compat call (Ollama / OpenAI) — returns full text string
function callOpenAI(messages, systemPrompt, baseUrl, apiKey, model) {
  return new Promise((resolve, reject) => {
    const sysMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;
    const body = JSON.stringify({ model, max_tokens: 1000, stream: false, messages: sysMessages });
    const url  = new URL('/v1/chat/completions', baseUrl);
    const lib  = url.protocol === 'https:' ? https : http;
    const req  = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          let text = j.choices?.[0]?.message?.content || '';
          // Strip qwen3 <think>...</think> blocks
          text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          resolve(text);
        } catch(e) { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function callLLM(messages, systemPrompt, cfg) {
  // provider, openaiBase, chatModel live inside cfg.keys (same as main.js)
  const keys      = cfg?.keys || {};
  const provider  = keys.provider || 'anthropic';
  const claudeKey = keys.anthropic || '';

  if (provider === 'openai' || provider === 'ollama') {
    const baseUrl = keys.openaiBase || 'http://127.0.0.1:11434/v1';
    const model   = keys.chatModel  || 'nyxia:latest';
    return callOpenAI(messages, systemPrompt, baseUrl, keys.openai || '', model);
  }
  if (!claudeKey) throw new Error('No Anthropic API key configured');
  return callAnthropic(messages, systemPrompt, claudeKey);
}

function startApiServer(port, deps) {
  const {
    loadConfig, loadPersonality, loadUserProfile, loadSelf,
    buildSystemPrompt, classifyMessage,
    querySearch, fetchPage, fsListDir, fsReadFile, fsWriteFile,
  } = deps;

  _server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, CORS); res.end(); return;
    }

    // SSE — real-time push to phone
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('data: {"type":"connected"}\n\n');
      _sseClients.add(res);
      req.on('close', () => _sseClients.delete(res));
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'Nyxia API', version: '5.1' }));
      return;
    }

    // POST /message — main chat endpoint
    if (req.method === 'POST' && req.url === '/message') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) { res.writeHead(413); res.end(); } });
      req.on('end', async () => {
        try {
          const parsed  = JSON.parse(body);
          const text    = (parsed.text || '').trim();
          if (!text) { res.writeHead(400, CORS); res.end(JSON.stringify({ error: 'text required' })); return; }

          const history  = Array.isArray(parsed.history) ? parsed.history : [];
          const messages = [...history, { role: 'user', content: text }];

          // Same system prompt as Electron chat
          const personality = loadPersonality() || {};
          // Guard arrays so buildSystemPrompt doesn't throw on missing fields
          if (!Array.isArray(personality.traits))       personality.traits = [];
          if (!Array.isArray(personality.interests))    personality.interests = [];
          if (!Array.isArray(personality.catchphrases)) personality.catchphrases = [];
          const systemPrompt = buildSystemPrompt(
            personality, loadUserProfile(), '', '', loadSelf()
          );

          const cfg  = loadConfig();
          const mode = await classifyMessage(messages);
          let enrichedPrompt = systemPrompt;

          // Route enrichment exactly like claude-stream handler
          if (mode === 'search') {
            try {
              const results = await querySearch(text);
              enrichedPrompt = systemPrompt + `\n\n---\nWeb search results:\n${results}\n\nRespond as Nyxia.\n---`;
            } catch(e) { console.error('[api] search error:', e.message); }

          } else if (mode === 'fetch') {
            try {
              const { extractUrl } = deps; // optional — passed if available
              const url = extractUrl ? extractUrl(text) : null;
              if (url) {
                const content = await fetchPage(url);
                enrichedPrompt = systemPrompt + `\n\n---\nPage content:\n${content}\n\nRespond as Nyxia.\n---`;
              }
            } catch(e) { console.error('[api] fetch error:', e.message); }

          } else if (mode === 'browser') {
            try {
              const result = await browserExecute(text);
              enrichedPrompt = systemPrompt + `\n\n---\nBrowser action result:\n${result}\n\nReport what happened naturally. Respond as Nyxia.\n---`;
            } catch(e) { console.error('[api] browser error:', e.message); }

          } else if (mode === 'filesystem') {
            try {
              const { fsResolvePath } = deps;
              const fpath = fsResolvePath ? fsResolvePath(text) : null;
              const writeMatch = text.match(/\b(create|write|make|save)\b.*?file\b/i);
              const readMatch  = text.match(/\b(read|open|show|cat)\b.*?file\b/i);
              let fsResult = '';
              if (fpath) {
                if (writeMatch) {
                  const contentMatch = text.match(/content[:\s]+["']?(.+?)["']?$/i);
                  fsWriteFile(fpath, contentMatch ? contentMatch[1] : '');
                  fsResult = `File created at ${fpath}`;
                } else if (readMatch) {
                  fsResult = fsReadFile(fpath);
                } else {
                  fsResult = fsListDir(fpath);
                }
              }
              if (fsResult) enrichedPrompt = systemPrompt + `\n\n---\nFilesystem result:\n${fsResult}\n\nRespond as Nyxia.\n---`;
            } catch(e) { console.error('[api] fs error:', e.message); }
          }

          const response = await callLLM(messages, enrichedPrompt, cfg);

          // Broadcast to all SSE clients (other devices see this exchange)
          broadcastSSE({ type: 'message', source: 'phone', role: 'user',      content: text });
          broadcastSSE({ type: 'message', source: 'phone', role: 'assistant', content: response });
          // Notify desktop via callback so it appears in the Electron chat window
          if (deps.onPhoneMessage) deps.onPhoneMessage(text, response);

          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response, mode }));

        } catch(e) {
          console.error('[api] /message error:', e.message);
          res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Static files — serve PWA
    if (req.method === 'GET') { serveStatic(req, res); return; }

    res.writeHead(404, CORS); res.end(JSON.stringify({ error: 'not found' }));
  });

  _server.listen(port, '0.0.0.0', () => {
    console.log(`[api] Nyxia API listening on 0.0.0.0:${port}`);
  });

  _server.on('error', e => console.error('[api] server error:', e.message));
}

function stopApiServer() {
  if (_server) { _server.close(); _server = null; }
}

module.exports = { startApiServer, stopApiServer, broadcastSSE };
