/**
 * claude-watcher.js — Live tail of Claude Code session JSONL files
 *
 * Watches ~/.claude/projects/**\/*.jsonl for new tool calls and maps them
 * to brain sector firings so Nyxia's brain lights up when Claude Code works.
 *
 * Tool → Sector mapping:
 *   Read / Grep / Glob          → hippocampus  (memory recall)
 *   Bash / run_command          → cerebellum   (motor execution)
 *   Edit / Write                → prefrontal   (planning/output)
 *   Agent                       → mirror       (delegation/empathy)
 *   WebSearch / WebFetch        → amygdala_right (curiosity)
 *   mcp__claude-bridge__*       → stem         (system presence)
 *   ToolSearch                  → amygdala_right
 *   default                     → cortex_left  (language/processing)
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const chokidar = require('chokidar');

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

const TOOL_SECTOR_MAP = {
  Read:                         { sector: 'hippocampus',    intensity: 0.7 },
  Grep:                         { sector: 'hippocampus',    intensity: 0.8 },
  Glob:                         { sector: 'hippocampus',    intensity: 0.5 },
  Bash:                         { sector: 'cerebellum',     intensity: 0.9 },
  Edit:                         { sector: 'prefrontal',     intensity: 0.85 },
  Write:                        { sector: 'prefrontal',     intensity: 0.9 },
  Agent:                        { sector: 'mirror',         intensity: 1.0 },
  WebSearch:                    { sector: 'amygdala_right', intensity: 0.85 },
  WebFetch:                     { sector: 'amygdala_right', intensity: 0.7 },
  ToolSearch:                   { sector: 'amygdala_right', intensity: 0.6 },
  TaskCreate:                   { sector: 'prefrontal',     intensity: 0.6 },
  TaskUpdate:                   { sector: 'prefrontal',     intensity: 0.5 },
};

function toolToSector(toolName) {
  if (TOOL_SECTOR_MAP[toolName]) return TOOL_SECTOR_MAP[toolName];
  if (toolName.startsWith('mcp__claude-bridge__')) return { sector: 'stem', intensity: 0.7 };
  if (toolName.startsWith('mcp__'))                return { sector: 'cortex_left', intensity: 0.6 };
  return { sector: 'cortex_left', intensity: 0.5 };
}

// Track file read positions to only process new lines
const filePositions = new Map();

function processNewLines(filePath, fireFn) {
  const stat = fs.statSync(filePath);
  const prevSize = filePositions.get(filePath) || stat.size; // start from current end
  filePositions.set(filePath, stat.size);

  if (stat.size <= prevSize) return; // no new data

  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(stat.size - prevSize);
  fs.readSync(fd, buf, 0, buf.length, prevSize);
  fs.closeSync(fd);

  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant') continue;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const { sector, intensity } = toolToSector(block.name);
        fireFn(sector, intensity);
      }
    } catch (_) {
      // malformed line — skip
    }
  }
}

/**
 * Start watching Claude Code session files.
 * @param {function} fireFn  Called as fireFn(sector, intensity) for each tool call
 * @returns {function}       Call to stop watching
 */
function startClaudeWatcher(fireFn) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    console.warn('[claude-watcher] projects dir not found:', CLAUDE_PROJECTS);
    return () => {};
  }

  // Initialise positions for existing files (don't replay history)
  try {
    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS);
    for (const proj of projectDirs) {
      const dir = path.join(CLAUDE_PROJECTS, proj);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(dir, f);
        filePositions.set(fp, fs.statSync(fp).size);
      }
    }
  } catch (e) {
    console.warn('[claude-watcher] init scan error:', e.message);
  }

  const watcher = chokidar.watch(`${CLAUDE_PROJECTS}/**/*.jsonl`, {
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on('change', fp => {
    try { processNewLines(fp, fireFn); } catch (e) {
      console.warn('[claude-watcher] read error:', e.message);
    }
  });

  watcher.on('add', fp => {
    // New session file — seed position at current end
    try { filePositions.set(fp, fs.statSync(fp).size); } catch (_) {}
  });

  console.log('[claude-watcher] watching', CLAUDE_PROJECTS);
  return () => watcher.close();
}

module.exports = { startClaudeWatcher };
