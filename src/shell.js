// shell.js — Phase 4.5, revised 2026-08-20: execution moved to claude-bridge's
// scoped run_command (blocklist + cwd-scope checked server-side — see
// nyxia.yaml's tool_scope and claude-bridge/server.js's SHELL_BLOCKED). This
// file now only formats a shell-result object for the model; main.js wires
// the actual `executeShell` export to bridgeClient.bridgeRunCommand.

/**
 * Format a shell result ({ stdout, stderr, code, error }) into a
 * prompt-ready string.
 */
function formatResult({ stdout, stderr, code, error, cmd }) {
  const parts = [`Command: \`${cmd}\``];
  if (error === 'timeout') parts.push('Result: timed out after 15s');
  else if (code !== 0)     parts.push(`Exit code: ${code}${stderr ? `\nError: ${stderr}` : ''}`);
  if (stdout) parts.push(`Output:\n${stdout}`);
  else if (code === 0 && !error) parts.push('Output: (no output)');
  return parts.join('\n');
}

module.exports = { formatResult };
