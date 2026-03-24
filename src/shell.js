// shell.js — Phase 4.5: Shell execution loop
// Nyxia runs a command and reads the result back.
// Sandboxed to /var/home/kvoldnes/ — no sudo, no system paths.

const { exec } = require('child_process');
const path      = require('path');

const HOME      = '/var/home/kvoldnes';
const TIMEOUT   = 15000; // 15s default

// Commands that are never allowed regardless of path
const BLOCKED = /\b(sudo|rm\s+-rf|mkfs|dd\s+if|shutdown|reboot|halt|passwd|chmod\s+777|chown\s+root|pkill\s+-9\s+electron|kill\s+-9\s+1)\b/i;

/**
 * Sanitize and validate a command before execution.
 * Returns { ok, reason } — if ok is false, reason explains why.
 */
function validateCommand(cmd) {
  if (!cmd || !cmd.trim()) return { ok: false, reason: 'Empty command.' };
  if (BLOCKED.test(cmd)) return { ok: false, reason: 'Command blocked for safety.' };
  return { ok: true };
}

/**
 * Execute a shell command and return stdout + stderr + exit code.
 * All execution is in HOME as cwd.
 *
 * @param {string} cmd     — shell command to run
 * @param {number} timeout — ms timeout (default 15000)
 * @returns {Promise<{ stdout, stderr, code, error }>}
 */
function executeShell(cmd, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const check = validateCommand(cmd);
    if (!check.ok) return resolve({ stdout: '', stderr: check.reason, code: 1, error: check.reason });

    exec(cmd, { cwd: HOME, timeout, maxBuffer: 50 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: (stdout || '').trim().slice(0, 3000),
        stderr: (stderr || '').trim().slice(0, 500),
        code:   err?.code ?? 0,
        error:  err && err.killed ? 'timeout' : null
      });
    });
  });
}

/**
 * Format the shell result into a prompt-ready string.
 */
function formatResult({ stdout, stderr, code, error, cmd }) {
  const parts = [`Command: \`${cmd}\``];
  if (error === 'timeout') parts.push('Result: timed out after 15s');
  else if (code !== 0)     parts.push(`Exit code: ${code}${stderr ? `\nError: ${stderr}` : ''}`);
  if (stdout) parts.push(`Output:\n${stdout}`);
  else if (code === 0 && !error) parts.push('Output: (no output)');
  return parts.join('\n');
}

module.exports = { executeShell, formatResult, validateCommand };
