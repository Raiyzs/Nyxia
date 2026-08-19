// agent-loop.js — Phase 10.1: Ollama-native tool use agent loop
// Uses nyxia-ft with Ollama /api/chat tools array.
// Each step: model decides tool → we execute → result fed back → repeat.
// Max 15 steps. Final answer returned as string.
//
// Shared tool metadata (WORLD tools — shell, search, web, filesystem, browser,
// harness-scoped bridge tools) now lives in tool-schemas.js as one
// format-agnostic source, converted here via toOllamaFormat(). Only
// desktop_action — not meaningful for nyxia-tools.js's Claude-backed brain —
// stays defined in this file. Add a tool both brains should have to
// tool-schemas.js; add an agent-loop-only tool below.

const http = require('http');
const { SHARED_TOOLS, toOllamaFormat } = require('./tool-schemas');
const { OLLAMA_URL } = require('./config/ollama-endpoint');

const AGENT_MODEL = 'nyxia-ft';
const MAX_STEPS   = 15;

// ── Agent-loop-only tool definitions (Ollama format via toOllamaFormat) ────────

const AGENT_ONLY_TOOLS = [
  {
    name: 'desktop_action',
    description: 'Control the desktop: launch apps, click UI elements, type in windows, list running apps.',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Natural language desktop instruction' }
      },
      required: ['instruction']
    }
  }
];

const TOOL_SCHEMAS = [...toOllamaFormat(SHARED_TOOLS), ...toOllamaFormat(AGENT_ONLY_TOOLS)];

// ── Ollama /api/chat call ─────────────────────────────────────────────────────

function ollamaChat(messages, tools, model = AGENT_MODEL) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      tools,
      stream:  false,
      think:   false,
      options: { temperature: 0.2, num_predict: 2048 }
    });

    const req = http.request(
      `${OLLAMA_URL}/api/chat`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Ollama bad JSON: ' + data.slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Ollama agent timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

async function executeTool(name, args, deps) {
  try {
    switch (name) {
      case 'shell': {
        const r = await deps.executeShell(args.command);
        return deps.formatResult({ ...r, cmd: args.command });
      }
      case 'web_search':
        return (await deps.querySearch(args.query)) || 'No results found.';
      case 'fetch_page':
        return (await deps.fetchPage(args.url)) || 'Failed to fetch page.';
      case 'fs_list':
        return await deps.fsListDir(args.path);
      case 'fs_read':
        return await deps.fsReadFile(args.path);
      case 'fs_write':
        return deps.fsWriteFile(args.path, args.content);
      case 'browser_action':
        return await deps.browserExecute(args.instruction);
      case 'desktop_action':
        return await deps.desktopExecute(args.instruction);
      case 'open_file':
        return await deps.bridgeOpenFile(args.path, args.app);
      case 'bridge_read_file':
        return await deps.bridgeReadFile(args.path);
      case 'bridge_list_files':
        return await deps.bridgeListFiles(args.path);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool error (${name}): ${e.message}`;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/**
 * Run the agent loop for a goal.
 *
 * @param {string}   goal    - Task description
 * @param {object}   deps    - Tool implementations injected from main.js
 * @param {function} onStep  - Optional callback(step, toolName, resultPreview)
 * @param {string}   model   - Optional Ollama model override (default: AGENT_MODEL)
 * @returns {Promise<string>} - Final answer text
 */
async function runAgentLoop(goal, deps, onStep = null, model = AGENT_MODEL) {
  const messages = [
    {
      role: 'system',
      content:
        `You are Nyxia's autonomous task agent. Use tools to complete the task step by step.\n` +
        `When the task is done, give a concise final summary — do NOT call any more tools.\n` +
        `Never call the same tool twice with identical arguments. Max ${MAX_STEPS} steps.`
    },
    { role: 'user', content: goal }
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await ollamaChat(messages, TOOL_SCHEMAS, model);
    } catch (e) {
      return `Agent error at step ${step + 1}: ${e.message}`;
    }

    const msg = response.message;
    if (!msg) return 'Agent returned empty message.';

    messages.push(msg);

    // No tool calls — model is done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '(task complete, no summary)';
    }

    // Execute each requested tool
    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (_) { args = {}; }
      }

      console.log(`[agent] step ${step + 1} → ${name}`, JSON.stringify(args).slice(0, 120));
      const result    = await executeTool(name, args, deps);
      const resultStr = String(result).slice(0, 2000);

      if (onStep) onStep(step + 1, name, resultStr);

      messages.push({ role: 'tool', content: resultStr });
    }
  }

  return `Agent reached max steps (${MAX_STEPS}) without finishing. Last recorded context preserved.`;
}

// ── Coding agent wrapper ──────────────────────────────────────────────────────
// Write code → run it → read error → fix → repeat. Same tools, focused prompt.

const CODING_SYSTEM =
  `You are a coding agent. Given a task:\n` +
  `1. Write the code to a file using fs_write\n` +
  `2. Run it with shell to check output/errors\n` +
  `3. If there are errors, read the file with fs_read, fix it, overwrite with fs_write, run again\n` +
  `4. Repeat until it runs cleanly or you've tried 5 fixes\n` +
  `5. Give a short summary of what was written and where it lives\n` +
  `Write to /var/home/kvoldnes/ paths. Use the right extension for the language.`;

async function runCodingLoop(task, deps, onStep = null) {
  return runAgentLoop(`${CODING_SYSTEM}\n\nTask: ${task}`, deps, onStep);
}

module.exports = { runAgentLoop, runCodingLoop, TOOL_SCHEMAS };
