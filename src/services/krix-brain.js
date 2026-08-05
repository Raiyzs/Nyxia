'use strict';
// services/krix-brain.js — KRIX-BRAIN API and brain-core process management.

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

let krixApiProc   = null;
let brainCoreProc = null;
let mcpDaemonProc = null;
let _krixContext  = '';

let _krixMemory = null;

function init({ krixMemory }) {
  _krixMemory = krixMemory;
}

async function ensureKrixApi() {
  try {
    const r = await fetch('http://127.0.0.1:7421/health');
    if (r.ok) { console.log('[krix-api] already running (systemd)'); return; }
  } catch (_) {}
  if (krixApiProc) return;
  const apiPath = '/var/home/kvoldnes/krix-brain/mcp/api.py';
  if (!fs.existsSync(apiPath)) return;
  krixApiProc = spawn('python3', [apiPath], { detached: false, stdio: 'pipe' });
  krixApiProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.log('[krix-api]', msg);
  });
  krixApiProc.on('error', e => console.warn('[krix-api] spawn error:', e.message));
  krixApiProc.on('exit', () => { krixApiProc = null; });
}

async function ensureBrainCore() {
  try {
    const r = await fetch('http://127.0.0.1:7422/health');
    if (r.ok) { console.log('[brain-core] already running (systemd)'); return; }
  } catch (_) {}
  if (brainCoreProc) return;
  const brainDir = '/var/home/kvoldnes/krix-brain';
  const agentApi = path.join(brainDir, 'brain_core', 'agent_api.py');
  if (!fs.existsSync(agentApi)) return;
  brainCoreProc = spawn('python3', ['-m', 'brain_core.agent_api'], {
    cwd: brainDir, detached: false, stdio: 'pipe',
    env: { ...process.env, PYTHONPATH: brainDir },
  });
  brainCoreProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.log('[brain-core]', msg);
  });
  brainCoreProc.on('error', e => console.warn('[brain-core] spawn error:', e.message));
  brainCoreProc.on('exit', () => { brainCoreProc = null; });
}

async function ensureMcpDaemon() {
  try {
    const r = await fetch('http://127.0.0.1:7425/mcp/', { signal: AbortSignal.timeout(2000) });
    if (r.status) { console.log('[krix-mcp] already running'); return; }
  } catch (_) {}
  if (mcpDaemonProc) return;
  const serverPath = '/var/home/kvoldnes/krix-brain/mcp/server.py';
  if (!fs.existsSync(serverPath)) return;
  mcpDaemonProc = spawn('python3', [serverPath, '--http'], {
    cwd: path.dirname(serverPath), detached: false, stdio: 'pipe',
  });
  mcpDaemonProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.log('[krix-mcp]', msg);
  });
  mcpDaemonProc.on('error', e => console.warn('[krix-mcp] spawn error:', e.message));
  mcpDaemonProc.on('exit', () => { mcpDaemonProc = null; });
}

async function refreshKrixContext(conversationTopic = '') {
  try {
    const query = conversationTopic || 'Kristian projects current work life';
    const results = await _krixMemory.searchBrain(query, { top_k: 4 });
    if (results.length === 0) { _krixContext = ''; return; }
    _krixContext = results.map(r => r.snippet.trim()).filter(Boolean).join('\n\n');
  } catch { _krixContext = ''; }
}

module.exports = {
  init,
  ensureKrixApi,
  ensureBrainCore,
  ensureMcpDaemon,
  refreshKrixContext,
  getKrixContext: () => _krixContext,
};
