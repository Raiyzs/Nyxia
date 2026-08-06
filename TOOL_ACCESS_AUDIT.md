# Nyxia Tool Access Audit

Verification pass, not a build. Every claim below was checked against actual file
contents, actual call chains from a real entrypoint, actual running processes, and
the actual live config file — not inferred from imports, comments, or naming.
Audited 2026-08-06, ~22:00.

## Live status at time of audit

Only `nyxia-vessel.js` (a lightweight background sensor daemon, port 7424 — clipboard/
screen-lock/system-load polling, no LLM, no tools) was running. **The Electron app
(`main.js`, which hosts every chat/tool code path described below) was not running.**
Everything below is about what's live *when the app is launched* — confirmed by
tracing real call chains, not "would work in theory."

Also confirmed running: Ollama (`11434`, real chat backend), claude-bridge (`3456`,
`/health` responds), krix-brain's MCP daemon (`7425`). SearXNG (`8888`) returned 404
on `/` (didn't check its actual search endpoint).

---

## The short version

Nyxia has **two separate, fully-coded native tool systems** in her own repo
(`nyxia-tools.js` for Claude-format tool use, `agent-loop.js` for Ollama-native tool
use). Only **one of them is reachable in her current live configuration** — the other
is wired end-to-end but structurally dead given how she's configured right now.
Separately, **she has no way to open a file for you to look at** — she can read file
contents and list directories, but nothing in her toolbox can put a file on your
screen. And **claude-bridge's tools are not reachable from her process at all** — that
was the key open question, and the answer is a clean no.

---

## 1. What she can do today, confirmed live

### The routing layer that runs on every message
`src/llm/router.js::classifyMessage()` runs inline, synchronously, on every
`claude-stream` IPC call (`src/ipc/chat.js:83`) — before any LLM response is
generated. It's regex fast-paths first, then (if ambiguous) a real Ollama call
asking a small model to pick a mode. This is a genuine **direct, un-queued,
immediate path** — see section 4.

Of the modes it can return, `src/ipc/chat.js`'s mode switch (lines 131–203) actually
implements: `council`, `agent`, `shell`, `filesystem`, `search`, `dialog`. Each of
these executes synchronously and feeds the result into the *same* reply — no
queueing, no confirmation round trip.

- **`shell`** — only fires if the message has a command in backticks or matches
  `\brun\s+(.+)$`. Runs via `src/shell.js::executeShell()` — real, cwd pinned to
  `/var/home/kvoldnes`, blocklist (not allowlist) rejects `sudo`, `rm -rf`, `mkfs`,
  `shutdown`, etc.
- **`filesystem`** — path pulled from the message via regex requiring an explicit
  absolute path or `~/…`. Real read/write via `src/tools.js` (`fsReadFile`/
  `fsWriteFile`), sandboxed to `/var/home/kvoldnes` (`fsSanitize` rejects anything
  that resolves outside it).
- **`search`** — real SearXNG call (`querySearch`, `src/tools.js`).
- **`agent`** (triggered by a literal `agent:` prefix, or the Ollama classifier
  deciding the task needs multiple tools in sequence) — hands off to
  `src/agent-loop.js::runAgentLoop()`. This is the most capable thing she has: a
  genuine multi-step (up to 15 steps) Ollama-native tool loop against `nyxia-ft`,
  with `shell`, `web_search`, `fetch_page`, `fs_list`, `fs_read`, `fs_write`,
  `browser_action`, `desktop_action`. **Confirmed live and reachable independent of
  which chat LLM backend answers the conversation** — it's called directly from
  `chat.js`, not gated behind the Claude-tools question below.

### Desktop and browser control (real, but narrower than they look)
- `src/desktop.js::desktopExecute()` — real: spawns apps, closes apps (via `pkill`),
  clicks UI elements (AT-SPI/`dogtail` bridge), focuses windows (KWin `qdbus`). But
  its "open/launch" regex is `\b(?:open|launch|start|run)\s+([a-zA-Z][a-zA-Z0-9_\-.]+)`
  — **the capture group does not allow `/`**. It can launch a bare app name
  (`open code`, `open firefox`) but cannot take a file path. "Open
  `/var/home/kvoldnes/report.pdf`" does not match this pattern at all.
- `src/browser.js::browserExecute()` — real, but not Playwright (despite that being
  a `package.json` dependency — the comment at the top of the file says "replaces
  Playwright"). It drives the app's own embedded Electron `webview` via
  `webContents`, and only works once the combined window has registered that
  webview's `webContentsId` over IPC. Controls live web pages — not local files.

---

## 2. What's completely missing

**Nothing resembling "open a file in an external app," anywhere in her own tool
surface.** No `open_in_vscode` equivalent, no "open this on your desk" gesture. She
can read file contents (`fs_read`, capped at 3000 chars) and list a directory
(`fs_list`) — but she has no primitive that causes a file to appear on your screen in
any viewer or editor. The closest candidate, `desktop_action`'s launch regex, is
structurally incapable of taking a path (see above). This is a real, confirmed gap,
not an adjacent capability being stretched to fit.

**No MCP client library at all.** `package.json` has no `@modelcontextprotocol/sdk`
or equivalent. Structurally, her process cannot speak MCP over the standard SDK
route to any server.

---

## 3. What's present but broken or unreachable

### NYXIA_TOOLS (`src/nyxia-tools.js`) — fully wired, currently unreachable
This is Nyxia's *other* native toolbox: `shell`, `web_search`, `fetch_page`,
`fs_read`, `fs_write`, `fs_list`, `browser_action`, plus self-tools (`set_mood`,
`fire_brain`, `show_thought`). It's passed as `tools: NYXIA_TOOLS` to the real
Anthropic Messages API inside `streamAnthropicAgentic()` (`src/main.js:1148–1285`),
and `runTool()` is genuinely called (`main.js:1273`) with real deps. This is not
dead code in the "never imported" sense — it's dead in the "never reached at
runtime" sense, and here's why:

- Live config (`~/.config/Nyxia/nyxia-config.json`): `keys.provider = "openai"`,
  `keys.openaiBase = "http://127.0.0.1:11434/v1"` (Ollama). `keys.anthropic = ""`.
  Confirmed no `ANTHROPIC_API_KEY` in env or `.bashrc` — `launch.sh` sources
  `.bashrc` before starting Electron, so the process gets nothing.
- `chat.js:205`: `const pc = getProviderConfig(keys)` — this is
  `src/llm/providers.js::getProviderConfig`, which for `provider: "openai"` returns
  a truthy Ollama config. Because `pc` is truthy, `chat.js` always calls
  `streamOpenAI()` for the actual reply — **never `streamAnthropicAgentic()`**, and
  `streamOpenAI()`'s request body has no `tools` field at all.
- The only two ways `streamAnthropicAgentic()` could fire: (a) the `else` branch
  when `pc` is falsy — unreachable given current config; (b) an
  ECONNREFUSED/ENOTFOUND fallback-on-error handler (`chat.js:214–227`) — but that
  handler is gated on `claudeKey` being truthy, and `claudeKey` is currently empty,
  so **even Ollama going down would not trigger it**.

Net effect: NYXIA_TOOLS is real, tested-looking, fully plumbed — and simply never
executes under how she's configured today.

### The bridge fallback — the specific issue flagged going in, confirmed
`src/llm/adapter.js`'s `bridge` provider config targets claude-bridge's `/v1/messages`
proxy (port 3456) as a fallback *conversational* LLM backend (chat via Claude's OAuth
session instead of a raw API key) — separate from NYXIA_TOOLS above, and **not** about
invoking claude-bridge's file/shell/history tools. Two problems, stacked:
1. It's currently unreachable anyway: this branch only auto-activates when
   `cfg.llm.provider === 'anthropic'` with no key present (`adapter.js:110–117`).
   Live config has `llm.provider: 'local'`, so this code path isn't even entered.
2. If it were reached, it would fail: claude-bridge's `/v1/messages` route requires
   `requireAuth` — a `Bearer <token>` in `Authorization`, issued through
   claude-bridge's own OAuth flow (`claude-bridge/server.js:503`, `:407–409`).
   `adapter.js`'s bridge config sets `apiKey: ''` and, for `family: 'anthropic'`,
   only ever sends `x-api-key` (empty, so omitted) — it never sends an
   `Authorization: Bearer` header at all. This would 401.

### Two more real bugs found along the way (not previously flagged, both minor)
- `router.js::classifyMessage()` can return `browser`, `desktop`, `fetch`, or
  `image` — but `chat.js`'s mode switch has no branch for any of them. They silently
  fall through to plain conversation, discarding the classification. (`filesystem`,
  `shell`, `search`, `agent`, `council`, `dialog` are the only modes actually acted
  on.)
- `chat.js` has a `mode === 'coding'` branch (lines 155–165) that calls
  `runCodingLoop()` — but `classifyMessage()` never returns `'coding'` as a value
  (not in its regex fast-paths, not in the LLM classifier's enum). This branch is
  unreachable dead code.

---

## 4. The claude-bridge question — answered directly

**No. Nyxia's process has no MCP client connection to claude-bridge, on either
transport, and no HTTP-level path to its tool set either.** The only two references
to claude-bridge inside `nyxia/src` are:

1. **`src/claude-watcher.js`** — purely passive. It tails Claude Code's own session
   logs (`~/.claude/projects/**/*.jsonl`) and fires brain-sector animations when it
   sees Claude Code (i.e., sessions like this one) invoke a tool, including
   `mcp__claude-bridge__*` ones. This is ambient awareness that Claude Code is
   working — zero capability transfer. She watches; she doesn't call.
2. **`src/llm/adapter.js`'s `bridge` config** — a fallback *chat* backend, not a tool
   path, covered in section 3 (unreachable + broken auth even if reached).

claude-bridge's actual tools (`list_files`, `read_file`, `write_file`, `run_command`,
`open_in_vscode`, `get_claude_history`, `search_sessions`, `session_insights`,
`get_memory`, `sync_brain_web`, `index_sessions`) remain reachable **only from Claude
Code sessions**, exactly as before.

One useful data point for later: Nyxia *does* already act as an MCP client somewhere
else in her own code. `src/krix-memory.js::_mcpCall()` is a hand-rolled JSON-RPC 2.0
client over plain HTTP, hitting krix-brain's MCP daemon on port 7425
(`search_brain`, `resolve_followup`, etc.) — not the official SDK, a different
server, but proof the pattern is already precedented in her codebase if this is ever
worth revisiting for claude-bridge specifically.

---

## Direct-vs-Jarvis: confirmed shape, and recommendation

**Confirmed: a direct, un-queued, immediate-response path already exists, separate
from Jarvis, and is already live for exactly the kind of quick actions in question.**
`classifyMessage()` → `chat.js`'s mode switch → tool call → result folded into the
same reply, same turn, no queueing. Jarvis's queue (`tryResolveUncertainTask`,
`src/awareness/proactive.js`) is a narrower, separate mechanism that only engages
when a *previous* classification came back low-confidence and Jarvis is waiting on
you to say which worker should take it — it's the ambiguity fallback, not the
default route for ordinary action requests. These two already coexist without
conflict; there's no missing "direct path" to design from scratch.

**Recommendation: don't build a new direct-path mechanism — the smallest fix closes
the actual gap (opening a file) using what's already wired.** Extend
`desktop.js::desktopExecute()`'s launch-match regex to accept paths (allow `/` and
`~`), and route a path-shaped target to `xdg-open <path>` instead of bare
`spawn(name, [])`. That's it — this reuses the `desktop_action` tool that's already
part of `agent-loop.js`'s live, synchronous, `mode: 'agent'` path (section 1), so
"open the report on my desk" becomes reachable with a small, targeted change to one
regex and one branch, no new tool definition, no new classifier mode, no MCP client.
Wiring an MCP connection to claude-bridge is a heavier lift that solves a different
problem (things Nyxia has no equivalent for at all, like `get_claude_history` /
`session_insights`) — worth keeping in mind for later, not needed for this ask.

Not implemented here — this file is verification only, per the audit scope.
