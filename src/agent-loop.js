// agent-loop.js — Phase 10.1: Ollama-native tool use agent loop
// Uses qwen3:8b with Ollama /api/chat tools array.
// Each step: model decides tool → we execute → result fed back → repeat.
// Max 15 steps. Final answer returned as string.

const http = require('http');

const OLLAMA_URL  = 'http://127.0.0.1:11434';
const AGENT_MODEL = 'qwen3:8b';
const MAX_STEPS   = 15;

// ── Tool schemas (OpenAI-compatible format) ───────────────────────────────────

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command on the local machine. Sandboxed to /var/home/kvoldnes. Returns stdout, stderr, exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web via SearXNG. Use this FIRST for information lookup — faster than browser. Returns top 3 results with title, snippet, and URL.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: 'Fetch and extract text content from a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description: 'List files and directories at a path under /var/home/kvoldnes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to list' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description: 'Read a file under /var/home/kvoldnes. Returns up to 3000 chars.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to file' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_write',
      description: 'Write content to a file under /var/home/kvoldnes.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Absolute path to file' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_action',
      description: 'Control a real browser: navigate to URL, click elements, type, read page content. Use only when web_search is insufficient or you need to interact with a logged-in site.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Natural language browser instruction' }
        },
        required: ['instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
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
  }
];

// ── Ollama /api/chat call ─────────────────────────────────────────────────────

function ollamaChat(messages, tools) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:   AGENT_MODEL,
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
        return deps.fsListDir(args.path);
      case 'fs_read':
        return deps.fsReadFile(args.path);
      case 'fs_write':
        return deps.fsWriteFile(args.path, args.content);
      case 'browser_action':
        return await deps.browserExecute(args.instruction);
      case 'desktop_action':
        return await deps.desktopExecute(args.instruction);
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
 * @returns {Promise<string>} - Final answer text
 */
async function runAgentLoop(goal, deps, onStep = null) {
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
      response = await ollamaChat(messages, TOOL_SCHEMAS);
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
