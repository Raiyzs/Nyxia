'use strict';
// services/searxng.js — SearXNG private search container lifecycle.

const { spawn } = require('child_process');

const SEARXNG_URL = 'http://127.0.0.1:8888';

async function ensureSearXNG() {
  try {
    const r = await fetch(`${SEARXNG_URL}/healthz`);
    if (r.ok) { console.log('[searxng] already running'); return; }
  } catch (_) {}
  console.log('[searxng] starting container...');
  spawn('podman', ['start', 'nyxia-searxng'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`${SEARXNG_URL}/healthz`);
      if (r.ok) { console.log('[searxng] ready'); return; }
    } catch (_) {}
  }
  console.warn('[searxng] did not become ready in time');
}

module.exports = { ensureSearXNG, SEARXNG_URL };
