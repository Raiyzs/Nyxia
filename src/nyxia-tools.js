'use strict';
// ── nyxia-tools.js — Nyxia's native tool definitions (Anthropic format) ───────
//
// Shared tool metadata (WORLD tools — shell, search, web, filesystem, browser,
// harness-scoped bridge tools) now lives in tool-schemas.js as one
// format-agnostic source, converted here via toAnthropicFormat(). Only
// SELF tools (mood, brain sectors, avatar, UI) — meaningless to agent-loop.js's
// Ollama brain — stay defined in this file. Add a tool both brains should have
// to tool-schemas.js; add a Nyxia-only SELF tool below.
//
// These are passed directly to the Claude API as the `tools` array.
// Nyxia calls them herself — no classify-then-inject middleman.
//
// The executor (runTool) is called by the agentic loop in main.js.

const { SHARED_TOOLS, toAnthropicFormat } = require('./tool-schemas');

// ── SELF tool definitions (Nyxia-only, Anthropic format via toAnthropicFormat) ─

const NYXIA_ONLY_TOOLS = [
  {
    name: 'set_mood',
    description: 'Set your own emotional state and avatar animation. Use this when your mood genuinely shifts during a conversation — not as performance, but as honest expression.',
    parameters: {
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
    parameters: {
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
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The thought to show' }
      },
      required: ['text']
    }
  }
];

const NYXIA_TOOLS = [...toAnthropicFormat(SHARED_TOOLS), ...toAnthropicFormat(NYXIA_ONLY_TOOLS)];

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
