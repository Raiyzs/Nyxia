'use strict';
// ── tool-schemas.js — single source of truth for Nyxia's tool metadata ────────
//
// Tool names, descriptions, and parameter schemas used to be hand-maintained
// twice: once in nyxia-tools.js (Anthropic tool-use format, the format her
// Claude-backed brain would use) and once in agent-loop.js (Ollama/OpenAI
// function-calling format, the format her live nyxia-ft brain actually
// uses). By the time this was extracted (2026-08-06, Prompt D
// reconciliation) the two copies had already drifted independently on
// wording for shell/web_search/fetch_page/fs_write/browser_action — proof
// the duplication was a real risk, not a theoretical one. This file is the
// fix: one format-agnostic {name, description, parameters} definition per
// shared tool, converted to each wire format by toAnthropicFormat()/
// toOllamaFormat() below. Add or edit a tool both brains should have here,
// not in either consumer.
//
// Where the two prior copies disagreed on wording, one existing version was
// kept verbatim (not rewritten) — picked for accuracy against the real
// implementation (e.g. fs_write's parameter description now matches
// tools.js's actual FS_ROOT sandboxing) or arbitrarily where both were
// equally accurate. No tool behavior changed by this file.
//
// Tools that only exist for one brain — desktop_action (agent-loop.js only)
// and set_mood/fire_brain/show_thought (nyxia-tools.js only, SELF tools) —
// are NOT here. They stay defined in their own consumer file, in this same
// shape, and run through the same adapters below.

const SHARED_TOOLS = [
  {
    name: 'shell',
    description: 'Run a shell command on this machine. Use for reading system state, running scripts, checking processes, or any local task. Returns stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' }
      },
      required: ['command']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web via SearXNG. Use this first for any information lookup — faster than fetching pages. Returns top results with title, snippet, and URL.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_page',
    description: 'Fetch and read the text content of a URL. Use after web_search when you need the full page, or when given a direct URL to read.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' }
      },
      required: ['url']
    }
  },
  {
    name: 'fs_read',
    description: 'Read a file. Returns up to 3000 characters. Limited to Documents, Desktop, nyxia, and claude-projects — same restriction as bridge_read_file, not a broader-access alternative.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' }
      },
      required: ['path']
    }
  },
  {
    name: 'fs_write',
    description: 'Write content to a file under /var/home/kvoldnes.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'fs_list',
    description: 'List files and directories at a path. Limited to Documents, Desktop, nyxia, and claude-projects — same restriction as bridge_list_files, not a broader-access alternative.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path' }
      },
      required: ['path']
    }
  },
  {
    name: 'browser_action',
    description: 'Control the browser: navigate to a URL, click elements, type, read page. Use only when web_search is not enough or you need to interact with a logged-in site.',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Natural language browser instruction' }
      },
      required: ['instruction']
    }
  },
  // ── Harness-scoped tools (claude-bridge, via bridge-client.js) ────────────
  // Narrower than fs_read/fs_list (limited to Documents/Desktop/nyxia/
  // claude-projects, checked by claude-bridge itself, not just local
  // sandbox convention). See krix-brain/AGENT_TOOL_SCOPE.md.
  {
    name: 'open_file',
    description: 'Open a file or folder on Kristian\'s screen — use this for "open the report", "show me that file", etc. Only works for paths inside Documents, Desktop, nyxia, or claude-projects.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file or folder to open' },
        app: { type: 'string', enum: ['vscode', 'dolphin', 'kate'], description: 'Which app to open it in — dolphin for folders/browsing, kate for a quick text read, vscode (default) for code/project files' }
      },
      required: ['path']
    }
  },
  {
    name: 'bridge_read_file',
    description: 'Read a file — limited to paths inside Documents, Desktop, nyxia, or claude-projects. fs_read has the identical restriction now; it is not a fallback for out-of-scope paths.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' }
      },
      required: ['path']
    }
  },
  {
    name: 'bridge_list_files',
    description: 'List a directory — limited to paths inside Documents, Desktop, nyxia, or claude-projects. fs_list has the identical restriction now; it is not a fallback for out-of-scope paths.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory' }
      },
      required: ['path']
    }
  },
  // ── KRIX-BRAIN's own MCP daemon (krix-memory.js, port 7425) — separate
  // channel from claude-bridge above, already trusted for resolveFollowup/
  // recordJarvisResolution (writes). This is read-only.
  {
    name: 'search_brain',
    description: 'Semantic search over KRIX-BRAIN\'s shared knowledge — episodes, sessions, project notes, code. Use this to recall real project history instead of guessing from your own mood/reflection memory alone.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' }
      },
      required: ['query']
    }
  }
];

// ── Format adapters ────────────────────────────────────────────────────────

// Anthropic Messages API tool-use format: { name, description, input_schema }
function toAnthropicFormat(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}

// Ollama/OpenAI function-calling format: { type: 'function', function: {...} }
function toOllamaFormat(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

module.exports = { SHARED_TOOLS, toAnthropicFormat, toOllamaFormat };
