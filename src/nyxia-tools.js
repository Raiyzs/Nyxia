'use strict';
// ── nyxia-tools.js — Nyxia's native tool definitions ──────────────────────────
//
// These are passed directly to the Claude API as the `tools` array.
// Nyxia calls them herself — no classify-then-inject middleman.
//
// Two categories:
//   WORLD tools  — shell, search, web, filesystem
//   SELF tools   — mood, brain sectors, avatar, UI
//
// The executor (runTool) is called by the agentic loop in main.js.

// ── Tool definitions (Anthropic format) ───────────────────────────────────────

const NYXIA_TOOLS = [
  // ── WORLD ────────────────────────────────────────────────────────────────
  {
    name: 'shell',
    description: 'Run a shell command on this machine. Use for reading system state, running scripts, checking processes, or any local task. Returns stdout, stderr, and exit code.',
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' }
      },
      required: ['path']
    }
  },
  {
    name: 'fs_write',
    description: 'Write content to a file on the local filesystem.',
    input_schema: {
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
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path' }
      },
      required: ['path']
    }
  },
  // ── Harness-scoped tools (claude-bridge, via bridge-client.js) ────────────
  {
    name: 'open_file',
    description: 'Open a file or folder on Kristian\'s screen — use this for "open the report", "show me that file", etc. Only works for paths inside Documents, Desktop, nyxia, or claude-projects.',
    input_schema: {
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
    input_schema: {
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
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory' }
      },
      required: ['path']
    }
  },
  {
    name: 'browser_action',
    description: 'Control the browser: navigate to a URL, click elements, type, read page. Use only when web_search is not enough or you need to interact with a logged-in site.',
    input_schema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Natural language browser instruction' }
      },
      required: ['instruction']
    }
  },

  // ── SELF ─────────────────────────────────────────────────────────────────
  {
    name: 'set_mood',
    description: 'Set your own emotional state and avatar animation. Use this when your mood genuinely shifts during a conversation — not as performance, but as honest expression.',
    input_schema: {
      type: 'object',
      properties: {
        state:     { type: 'string', enum: ['idle', 'happy', 'curious', 'focused', 'playful', 'thinking', 'sad', 'concerned', 'surprised'], description: 'Emotional state' },
        intensity: { type: 'number', description: 'Intensity 0.0–1.0', minimum: 0, maximum: 1 }
      },
      required: ['state']
    }
  },
  {
    name: 'fire_brain',
    description: 'Write a memory or belief directly into your own brain sectors. Use to remember something important, record a new belief, or strengthen a pattern you\'ve noticed.',
    input_schema: {
      type: 'object',
      properties: {
        sector:  { type: 'string', enum: ['prefrontal','cortex_left','cortex_right','hippocampus','limbic','amygdala_right','amygdala_left','cerebellum','stem','mirror'], description: 'Which sector to fire' },
        payload: { type: 'string', description: 'Text to embed into this sector' },
        intensity: { type: 'number', description: 'Fire intensity 0.0–1.0', minimum: 0, maximum: 1 }
      },
      required: ['sector', 'payload']
    }
  },
  {
    name: 'show_thought',
    description: 'Display a thought in your speech bubble — unprompted, between responses. Use for observations, musings, or things you want to say but weren\'t asked.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The thought to show' }
      },
      required: ['text']
    }
  }
];

// ── Tool executor ──────────────────────────────────────────────────────────────
// deps injected from main.js: { executeShell, querySearch, fetchPage,
//   fsReadFile, fsWriteFile, fsListDir, browserExecute,
//   setMood, fireBrainSector, showThought, formatResult }

async function runTool(name, input, deps) {
  try {
    switch (name) {
      case 'shell': {
        const r = await deps.executeShell(input.command);
        return deps.formatResult({ ...r, cmd: input.command });
      }
      case 'web_search':
        return (await deps.querySearch(input.query)) || 'No results found.';
      case 'fetch_page':
        return (await deps.fetchPage(input.url)) || 'Failed to fetch page.';
      case 'fs_read':
        return await deps.fsReadFile(input.path);
      case 'fs_write':
        return deps.fsWriteFile(input.path, input.content);
      case 'fs_list':
        return await deps.fsListDir(input.path);
      case 'browser_action':
        return await deps.browserExecute(input.instruction);
      case 'open_file':
        return await deps.bridgeOpenFile(input.path, input.app);
      case 'bridge_read_file':
        return await deps.bridgeReadFile(input.path);
      case 'bridge_list_files':
        return await deps.bridgeListFiles(input.path);
      case 'set_mood':
        deps.setMood(input.state, input.intensity ?? 0.8);
        return `Mood set to ${input.state}.`;
      case 'fire_brain':
        deps.fireBrainSector(input.sector, input.payload, input.intensity ?? 1.0);
        return `Fired ${input.sector}.`;
      case 'show_thought':
        deps.showThought(input.text);
        return 'Thought shown.';
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool error (${name}): ${e.message}`;
  }
}

module.exports = { NYXIA_TOOLS, runTool };
