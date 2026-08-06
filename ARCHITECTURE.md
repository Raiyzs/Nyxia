# Nyxia — Architecture

Somewhere between a chatbot and a familiar spirit sits Nyxia: a system built not to answer questions but to *notice things* — to watch, remember, and grow a self over time. What follows is the anatomy of that system, laid bare in plain words, so that anyone (human or AI) can find their way through it without getting lost in the machinery.

## What is this?

Nyxia is a desktop AI companion — a program that lives on Kristian's computer as a floating 3D character (an anime-style avatar) who can see what he's doing, talk to him by voice or text, remember things about him across days and months, and take actions on the computer (search the web, run commands, open apps). Think of it like a Tamagotchi crossed with Jarvis from Iron Man: it has a "body" (the 3D avatar you see on screen), a "brain" (AI language models that think and respond), a "memory" (databases that store what she's learned about Kristian and about herself), and "senses" (code that watches the screen, clipboard, and open windows). All of these pieces are wired together inside one desktop app built with Electron (a toolkit that lets web technology — HTML/JavaScript — behave like a real installed application with its own windows).

## The Big Picture

```
                              YOU (Kristian)
                    types, talks, moves the mouse, switches windows
                                     |
                                     v
   +--------------------------------------------------------------------+
   |               ELECTRON MAIN PROCESS  —  src/main.js                |
   |   The "spine." Owns every window, every background timer, all      |
   |   settings, and decides where each message and event should go.   |
   +---------------------+------------------------------+---------------+
                          | shows                        | shows
                          v                              v
   +----------------------------------+   +--------------------------------+
   |  space.html                      |   |  desktop-avatar.html            |
   |  the "Full Dive" main window:    |   |  a see-through floating window  |
   |  chat box, voice controls, a     |   |  showing ONLY the 3D avatar     |
   |  drifting particle/portal scene, |   |  (a VRM humanoid model) doing   |
   |  terminal + system panels        |   |  emotion-driven animations      |
   +----------------+-----------------+   +--------------------------------+
                     | every user message
                     v
   +--------------------------------------------------------------------+
   |                    src/llm/router.js  —  the traffic cop           |
   |  "what kind of request is this?"                                  |
   |  casual / dialog / council / agent / shell / browser / desktop /  |
   |  filesystem / search / image                                     |
   +----+-----------+------------+------------+------------+-----------+
        |           |            |            |            |
        v           v            v            v            v
   +--------+   +---------+  +----------+  +---------+  +----------+
   | CLOUD  |   | LOCAL   |  | MEMORY   |  | SENSES  |  | VOICE    |
   | BRAIN  |   | BRAIN   |  | STACK    |  |         |  |          |
   |Claude, |   |Ollama:  |  |Chroma,   |  |mind.js: |  |Whisper   |
   |Gemini, |   |nyxia-ft |  |LanceDB,  |  |screen,  |  |(ears) +  |
   |Groq,   |   |(her own |  |Kuzu      |  |clipboard|  |Chatterbox|
   |Grok... |   |trained  |  |graph,    |  |windows, |  |/Kokoro/  |
   |        |   |model),  |  |KRIX-BRAIN|  |files,   |  |Qwen3-TTS |
   |        |   |qwen2.5vl|  |(cross-   |  |load     |  |/Eleven-  |
   |        |   |(vision) |  |project   |  |         |  |Labs      |
   |        |   |         |  |memory)   |  |         |  |(mouth)   |
   +--------+   +---------+  +----------+  +---------+  +----------+
        \___________ all of this feeds a running "mood" number set __/
                    (backend/reflex_server.py, a tiny simulated
                     nervous system) that colors *how* she answers
```

In plain words: Kristian talks to a window (`space.html`) or sees her body float on the desktop (`desktop-avatar.html`). Everything he types or says goes to `main.js`, the traffic-control center. A small piece of code called the **router** reads the message and decides what kind of thing it is — a plain chat message, a request to search the web, a request to run a command, and so on. Depending on that, `main.js` calls out to one or more "brains" (either a cloud AI like Claude, or her own locally-trained AI model running on Kristian's graphics card), pulls in relevant **memories** (things she's learned before), checks her **senses** (what's on screen, what's in the clipboard), and finally sends a reply back to be shown in text, spoken out loud through a text-to-speech engine, and acted out as an animation on her 3D body. A background "mood" simulator constantly nudges eleven numbers (curiosity, tiredness, empathy, etc.) that quietly color her tone.

## The Pieces

### The skeleton — Electron app shell

- **`src/main.js`** (~1,700 lines) — the hub. Every other module gets `require()`'d in here. It creates windows, starts background services, and defines dozens of **IPC handlers** (IPC = "inter-process communication," the mailbox system Electron uses so a window and the background process can send each other messages). This is where chat streaming, screenshots, mood updates, tool calls, and settings all get wired together.
- **`src/window-manager.js`** — a factory for the app's windows. It defines four window-builders: `createCompanionWindow` (loads `index.html`), `createChatWindow` (loads `chat.html`), `createCombinedWindow` (loads `space.html`), and `createDesktopWindow` (loads `desktop-avatar.html`, only if "desktop mode" is turned on in settings). **Only the last two are actually called** when the app starts (see Rough Edges).
- **`src/preload.js`** — a tiny bridge file Electron loads before a web page's JavaScript runs, exposing a safe, limited `window.nyxia` object so the page can talk to the backend without having full Node.js power. (Small and mostly superseded by directly enabling `nodeIntegration` on the newer windows.)
- **`src/service-startup.js`** — boots the background helper programs Nyxia depends on: Chroma (vector database server), Ollama (local AI model server), and the Python "reflex" mood server, waiting for each to answer a health check before moving on. Also has a helper that waits for enough graphics-card memory (VRAM) to free up before loading a large model.
- **`launch.sh`** — the actual start command. Loads Node's version manager (nvm), makes sure Ollama is running, then runs `npm start`.
- **`nyxia-vessel.js`** — a small, separate daemon (not part of the Electron app at all) that keeps running on its own via a `systemd --user` service (`nyxia-vessel.service`), even when Nyxia herself is completely closed. It's a "while you were away" tracker: it sits on port 7424 doing nothing but watching CPU/RAM and logging a timestamp, and when Electron starts back up, `src/main.js` (see `_vesselFetch` around line 451) pings it to ask "was I gone, and for how long?" — if she was, that becomes a genuine memory ("Nyxia was alone for X minutes") fed into `mind.js` instead of Nyxia simply having no idea time passed at all.

### The windows (what you actually see)

- **`src/space.html`** (~2,100 lines) — the real, currently-used main window, nicknamed "Full Dive." It's a single self-contained page: a Three.js (a JavaScript library for drawing 3D graphics in a browser) particle/portal scene in the background, plus an inline chat box, voice recording button, a settings panel, and a terminal-style log panel — all built directly into this one file rather than split across separate windows.
- **`src/desktop-avatar.html`** — a borderless, transparent, always-on-top window that shows nothing but Nyxia's 3D body, parked in a corner of the screen. This is where the actual character animation happens (see "The body" below).
- **`src/chat.html`, `src/combined.html`, `src/index.html`** — older versions of the chat window and the "combined" avatar+chat layout. They still exist and still work as standalone files, but nothing in the current startup path loads them anymore (see Rough Edges — this is dead weight, not a lie in this document).
- **`src/brain-panel.html`** — a debug/visualization window (opened via `open-brain-panel` IPC) for peeking at brain-sector activity.
- **`pwa/`** — a tiny separate "Progressive Web App" (a website that can be added to a phone's home screen like an app) that talks to `src/api-server.js` so Kristian can message Nyxia from his phone.

### The brain — deciding what to say

- **`src/llm/router.js`** — reads the newest message and classifies it into a "mode" (casual chat, a real question, an agent task, a shell command, a browser action, a search, etc.), using fast keyword checks first and only asking a small local AI model to classify when it's genuinely ambiguous — this avoids a slow round-trip for every single message.
- **`src/llm/adapter.js`** — knows how to format a request for whichever cloud AI is configured (Claude/Anthropic by default, model `claude-sonnet-4-6`). It *can* fall back to a local proxy called `claude-bridge` (port 3456) reusing Kristian's Claude subscription login instead of a paid API key — but per `TOOL_ACCESS_AUDIT.md`, that specific fallback is currently unreachable given the live config (Ollama is the active provider) and would fail its own auth check even if reached. Don't confuse this with `bridge-client.js` below — same server, completely different purpose.
- **`src/llm/providers.js`** — the same idea but for "OpenAI-style" providers (Gemini, Groq, Mistral, Grok, DeepSeek, Kimi/Moonshot) — these all speak a very similar request format, so one function handles them all. This file also runs **"the Council"**: when enabled, it quietly asks 2–3 other AI models for a second opinion in parallel, which Nyxia can factor into how she "arbitrates" her own answer.
- **`src/prompt-builder.js`** — assembles the giant instruction block ("system prompt") sent to the AI on every turn: her personality, her current mood, her self-model ("what I'm doing / feeling right now"), recent memories, morning thoughts left over from an overnight "sleep cycle," and time-of-day flavor text (gentler in the morning, quieter late at night).
- **`src/agent-loop.js`** — a self-contained "agent" loop using Nyxia's own local model (`nyxia-ft`) through Ollama's tool-calling feature: the model picks a tool (shell, web search, fetch a page, read/write a file, control the browser, control the desktop), the code runs it, feeds the result back, and repeats (up to 15 steps) until the model gives a final answer with no more tool calls.
- **`src/nyxia-tools.js`** — a second, very similar set of tool definitions, but written for Claude's own native tool-use format rather than Ollama's. (Same idea, two schemas — see Rough Edges.)
- **`src/bridge-client.js`** — Nyxia's connection to the harness-level tool-scoping mechanism (built 2026-08-06, see `krix-brain/AGENT_TOOL_SCOPE.md`). A tiny stateless client (plain `fetch`, no MCP SDK — same reasoning as `krix-memory.js`) that calls claude-bridge's `POST /mcp` with a dedicated bearer token, giving her three tools — `open_file`, `bridge_read_file`, `bridge_list_files` — that are checked server-side against `krix-brain/agents/nyxia.yaml`'s `tool_scope` before they run. This is what actually lets her open a file for Kristian to see (`open_in_vscode`/Dolphin/Kate) — nothing else in her toolbox can put a file on screen. Wired into both `agent-loop.js` and `nyxia-tools.js`. `fs_read`/`fs_list` now route through this same client under the hood (bound in `main.js`, not a separate implementation) so the two tool names are functionally identical, just kept distinct for the model — see Rough Edges for why they weren't consolidated into one.

### The memory stack — what she remembers

Nyxia deliberately uses *several* different kinds of memory, each good at a different kind of question, unified through one traffic cop:

- **`src/memory-manager.js`** — the coordinator. Given a query, it asks all the memory stores below for relevant snippets, removes near-duplicates, and returns a length-capped, prioritized bundle of text to drop into the AI prompt.
- **`src/lance-memory.js`** — LanceDB (an embedded "vector database," meaning it finds text by *meaning* rather than exact keyword match, using AI-generated number fingerprints called embeddings). Stores her reflections, corrected mistakes, and "anchors" (one-sentence highlights of meaningful exchanges).
- **`src/graph-memory.js`** — Kùzu, an embedded graph database (a database built around "this connects to that" relationships rather than rows in a table). Stores memories as nodes with `RELATES_TO` edges between them, so she can trace *how* one memory connects to another, not just what's similar.
- **`src/brain-soul.js`** — talks to a local Chroma server (another vector database, run as a separate background process on port 8769) that holds "brain sectors" — named regions like `prefrontal`, `hippocampus`, `amygdala_right` — modeled loosely on real brain anatomy, each storing a different flavor of belief or cognitive event. Talks to it over raw HTTP on purpose, because the official `chromadb` npm package breaks Electron's module loader.
- **`src/krix-memory.js`** — a client for **KRIX-BRAIN**, a separate, bigger personal knowledge system Kristian runs (its own HTTP API on port 7421), used here for cross-project long-term memory that outlives any one app.
- **`src/memory/facts.js`** — a small "learned facts" extractor (inspired by the Mem0 pattern) that periodically asks a local model to pull 1–3 concrete facts about Kristian out of a conversation exchange and appends them to a capped list.
- **`src/config-manager.js`** — not a database, but the plain-JSON memory: settings, personality, self-beliefs, and the user profile are all simple `.json` files under `~/.config/Nyxia/` (Electron's per-app data folder), loaded/saved with plain `fs.readFileSync`/`writeFileSync`.

### The senses — noticing the world

- **`src/mind.js`** (~960 lines) — the awareness engine, described in its own header as four jobs in one file: **thought** (generates curiosity-driven internal thoughts), **conscious** (notices when the active window, running processes, or watched files change), **info** (keeps a rolling buffer of the last ~14 notable events as a summarized "context string"), and **eyes** (clipboard watching and screenshot-based visual context). It's an `EventEmitter` (a standard Node.js pattern for "fire an event, let anyone listening react") that `main.js` subscribes to.
- **`src/visual-cortex.js`** — turns a screenshot into a description using a vision-capable AI model (`qwen2.5vl:7b`, run locally through Ollama) so Nyxia can "see" the screen without sending images to the cloud.
- **`src/interoception.js`** — Nyxia's sense of her own "body," i.e., the computer's vitals (CPU, RAM, GPU VRAM).
- **`src/awareness/heartbeat.js`** — every 45 seconds, checks if enough has changed on screen to be worth an unprompted comment, scores the "urge to speak" from 0–1 using a quick local-model call, and if it crosses a threshold (and she isn't already talking too often), triggers her to say something on her own. Since 2026-08-05 it also polls krix-brain's `GET /followups` (via `krix-memory.js`'s `listUncertainFollowups()`) each tick for tasks Jarvis's Route stage couldn't confidently classify (tagged `jarvis-uncertain` — see krix-brain's `ARCHITECTURE.md`, the `mcp/` section). Finding one *raises the score* to a 0.55 floor rather than bypassing the threshold outright, so a backlog of low-priority queued tasks is throttled by the exact same 90-second cooldown as every other trigger instead of paging on its own schedule.
- **`src/awareness/proactive.js`** — actually generates and sends that unprompted line, with different prompt templates depending on the trigger (switched windows, clipboard copy, etc.), plus a cooldown so she doesn't spam. A `uncertain_task` trigger asks in plain language which worker (scout/ava/tom/bobby) should take a queued task, and remembers it as a self-expiring (20 min) pending question — `getPendingUncertainTask()`/`clearPendingUncertainTask()`. `ipc/chat.js` checks every incoming chat reply against that pending question before running the normal reply pipeline (`main.js`'s `tryResolveUncertainTask()`): a worker name in the reply resolves the followup (`resolve_followup`, MCP-only — `krix-memory.js`'s `resolveFollowup()`) and dispatches the task to that worker via the same `POST /agent` route a human picking a persona in the portfolio's Agent Room uses (`dispatchTask()`); anything else falls through untouched and the item just stays queued for the next heartbeat cycle to re-offer.
- **`src/awareness/self-model.js`** — every few minutes, asks a local model to fill in a small self-description ("what I'm doing," "how I'm feeling," "what I want right now") based on recent sensory context and mood, which then colors the next reply's system prompt.
- **`src/curiosity-gaps.js`, `src/environment-state.js`, `src/predicted-reality.js`, `src/other-model.js`, `src/shared-experience.js`, `src/sleep-cycle.js`, `src/somatic.js`, `src/subjective-time.js`, `src/context-layer.js`, `src/causal-model.js`, `src/action-tracker.js`, `src/claude-watcher.js`, `src/neural-sphere.js`** — a cluster of smaller "extended cognition" modules, each modeling one narrow psychological concept (open questions she's curious about, a model of what *Kristian* might be thinking, an overnight "sleep" consolidation cycle that produces a morning thought, a felt sense of time passing, live 3D "neuron" data for the sphere visualization, etc.). They're genuinely part of the design (not filler) but are small, single-purpose, and mostly just feed short strings into `prompt-builder.js`.

### The body — the 3D avatar

This is the most technically involved part of the project, spread across two locations: **art assets** (built once, offline, in Blender) and **runtime code** (loads and animates those assets live).

- **`3d avatar/`** — the character files. `girl_character.vrm` / `girl_character2.vrm` (and a `_test` variant) are **VRM** files — a 3D avatar file format built specifically for humanoid characters (popular with VTubers) that standardizes bone names so any VRM-aware code can animate any VRM model the same way. `Nyxia3dV2.glb` is an older, non-VRM 3D model (**GLB** is a common 3D file format that bundles the mesh, textures, and animations into one file) with a 40-bone "Mixamo-style" rig (Mixamo is Adobe's free library of pre-made human animations) and 41 named animations (idle, cheer, cry, dance, etc.). `nyxia-anims.glb` is a slimmed-down file (built by the root script `extract-anims.js`) containing *only* those 41 animation clips, stripped of the heavy mesh data, so the runtime code can load the animations without loading the whole old model.
- **`brain 3d/Nyxia-Brain.glb`** — a separate small model of 10 glowing "brain sectors" meant to live inside the avatar's head, lighting up in sync with `brain-soul.js` sector activity.
- **`blender_scripts/`** — a numbered pipeline of ~20 Python scripts (`00_full_reset.py` through `20_full_pipeline.py`, plus `face_rig.py`/`face_rig_v2.py`) meant to be run inside Blender (the free 3D modeling program, version 5.1 here) in order: reset the scene, inspect the mesh, create animations, export to GLB, attach the mesh to its skeleton ("parent to armature"), check and fix "weights" (which parts of the mesh each bone controls), auto-fit bones, add face bones and shape keys (for facial expressions/lip-sync), decimate (simplify the mesh to save performance), and finally export. `AVATAR-STEPS.txt` is a plain-English walkthrough of this same pipeline for a human following along.
- **`src/desktop-avatar.html`** — where the avatar actually comes alive at runtime. It loads a VRM file with Three.js's `GLTFLoader` plus the `@pixiv/three-vrm` library, then loads the *separate* Mixamo-style animation clips from `nyxia-anims.glb` and **retargets** them onto the VRM skeleton in real time — meaning it translates "move bone `L_Upperarm` this way" (from the old rig's naming and rest pose) into "move VRM bone `leftUpperArm` this way" (in the VRM's own naming and rest pose), using quaternion math (quaternions are a way of representing a 3D rotation with four numbers instead of three, avoiding a rotation-math bug called "gimbal lock"). Because the two rigs don't rest in the same pose (one rests arms-down, the VRM rests in a T-pose, arms straight out), there's a hand-tuned correction (`ARM_REST_OFFSET`) computed once from the loaded VRM's own T-pose to make the arms hang naturally instead of freezing in a T-pose.
- **`src/avatar-brain.js`** — the emotion engine. `analyzeEmotion()` looks at a chunk of AI-generated response text and decides which of nine emotions (happy, sad, curious, thinking, focused, playful, concerned, surprised, idle) it expresses, first trying a fast local-model call and falling back to simple keyword matching if that's too slow or fails. `NyxiaAvatarController` then plays the matching body animation (via an `ANIM_MAP` lookup table) and, if a VRM model is loaded, the matching facial expression (via `EXPR_MAP`), with a smooth cross-fade between animations.
- **`src/tts/pipeline.js`** — while she "talks," also picks a lightweight, no-AI, keyword-based emotion per sentence (separate from the full `avatar-brain.js` analysis, because sentence-by-sentence needs to be instant) to keep her expression changing naturally as she speaks.

### The voice — hearing and speaking

- **Speech-to-text (ears):** local Whisper (the "tiny" model) transcribes microphone recordings, with voice-activity detection (VAD — code that detects when someone is actually speaking vs. silence) and "barge-in" (the ability to interrupt her mid-sentence by talking).
- **`src/tts/servers.js`** — manages four different local text-to-speech engines as child processes, tried in priority order: Qwen3-TTS (GPU-accelerated, `qwen3_tts_server.py`, port 8884) → Kokoro (CPU, `kokoro_server.py`, port 8883) → Chatterbox/XTTS (`xtts_server.py`, port 8881) → ElevenLabs (a paid cloud TTS service) as the final fallback if nothing local is ready.
- **`src/tts/pipeline.js`** — splits her reply into sentences and fires each one to TTS as soon as it's ready (rather than waiting for the whole reply), so she starts speaking almost immediately instead of after a long pause.
- **`voicetrainer/`** — the offline pipeline for training a *custom* voice clone (transcribing sample audio, labeling it, fine-tuning XTTS on it) rather than using a generic voice.

### The toolbox — acting in the world

- **`src/shell.js`** — runs shell commands, but only inside `/var/home/kvoldnes`, with a blocklist regex (`BLOCKED`) refusing anything containing `sudo`, `rm -rf`, `mkfs`, `shutdown`, `passwd`, etc.
- **`src/tools.js`** — web search (via a self-hosted SearXNG search engine), fetching and reading a web page's text, and basic filesystem read/write/list helpers with an SSRF check (Server-Side Request Forgery — a check that stops the app from being tricked into fetching internal/private network addresses).
- **`src/browser.js`** — drives a real Chromium browser via Playwright (a browser-automation library) so Nyxia can click, type, and navigate real websites, including ones requiring login.
- **`src/desktop.js`** — controls the actual desktop: launching apps, clicking UI elements, typing into windows (via `ydotool`, a Linux input-simulation tool started automatically on app launch).
- **`src/ipc/`** — small files (`chat.js`, `media.js`, `streaming.js`, `terminal.js`, `window.js`) that organize the many `ipcMain` message handlers by topic instead of leaving them all crammed into `main.js`.
- **`scripts/desktop_action.py`** — a Python-side helper for desktop actions, used alongside the JS `desktop.js`.

### The backend — Python side-processes

- **`backend/main.py`** — nicknamed "the Limbic System." A small, dependency-light script (falls back to reading `/proc` directly if `psutil` isn't installed) that reports CPU/RAM/network numbers over stdout every 2 seconds. Deliberately stripped down — an April 2026 rewrite removed window/time-watching from here because `mind.js` now does that more efficiently in JavaScript.
- **`backend/reflex_server.py`** — the "reflex layer": a genuinely unusual piece for a companion app. It uses **Nengo** (a Python library for simulating spiking neural networks — networks of artificial neurons that fire in discrete pulses, more like real brain cells than a normal deep-learning network) to run a 512-neuron reservoir that takes in a text embedding and outputs the same 11 mood numbers used everywhere else in the app, then slowly "learns" (via a simple **Oja's rule** update, a biologically-inspired learning rule) how to map inputs to moods over time, giving her personality a slow, second, sub-symbolic drift on top of the explicit rules. It also exposes a `/reflect` endpoint that runs `reflexion.py`'s generator-critic-adjudicator loop.
- **`backend/reflexion.py`** — a "Reflexion" pattern (write a draft → have a stricter/cheaper model critique and score it 0–10 → revise → repeat up to 4 times → have a final model adjudicate) used for longer, more considered writing (journal entries, deep reflections) rather than live chat.
- **`chatterbox_server.py`, `kokoro_server.py`, `qwen3_tts_server.py`, `xtts_server.py`** — the actual Python FastAPI servers behind the TTS engines described above.
- **`wake_word.py`, `webcam_haptics.py`, `webcam_presence.py`, `hand_landmarker.task`** — experimental/partial sensor scripts: a passive "Hey Nyxia" wake-word listener, and webcam-based presence/hand-tracking (the `.task` file is a MediaPipe hand-landmark model file) — these read as exploratory add-ons rather than fully wired-in features (see `UPDATE.md`'s pending list, which still lists webcam and wake word as future work).

### The training ground — Nyxia's own local brain

A large chunk of the project's disk footprint (well beyond the app code itself) is the pipeline for training Nyxia's *own* dedicated local AI model, rather than relying only on cloud APIs:

- **`training-data/`, `training_data/`** — two separate folders (hyphen vs. underscore) with conversation data (`nyxia_training.jsonl`) and generation scripts for building a fine-tuning dataset in Nyxia's voice.
- **`merge_lora.py`, `Modelfile`, `nyxia*.Modelfile`** — **LoRA** (Low-Rank Adaptation — a cheap way to fine-tune a huge model by only training a small "adapter" layer instead of the whole thing) merge scripts and Ollama "Modelfile" definitions (Modelfiles tell Ollama how to package a model: base weights + system prompt + parameters) for several personality variants (`nyxia-dolphin`, `nyxia-qwen`, `nyxia-qwen3-8b`, etc.).
- **`nyxia-merged/`** — a full merged model checkpoint in HuggingFace "safetensors" format (the modern, safer alternative to old `.pt`/pickle model files) — this is the fine-tuned model *before* it gets compressed for local use.
- **`Finetuned_Nyxia_qwen/`, `nyxia.gguf`, `nyxia-part-aa`** — the compressed, ready-to-run versions. **GGUF** is a file format (used by `llama.cpp`/Ollama) that packs a huge model down to a few gigabytes using quantization (rounding each number in the model to fewer bits, trading a little accuracy for a lot less memory) so it can run entirely on Kristian's own graphics card instead of needing the cloud.
- **`unsloth_compiled_cache/`** — cached compiled code from **Unsloth**, a library that speeds up and reduces the memory needed for this kind of fine-tuning.

### Everything else

- **`assets/`** — static app assets: logo, banner images, app icon.
- **`3dspace/`, `godot-mcp/`** — mostly-empty folders (see Rough Edges).
- **`docs/`** — the project's own memory, for humans and AI sessions alike: `CHANGES.md` (a running dev log, read at the start of every session per the house rules), `CONTEXT.md` (an architecture snapshot for quickly re-briefing an AI), `UPDATE.md`/`UPDATE2.md` (research and a prioritized roadmap), `STARTUP_MEMORY.md` (Nyxia's full personality document, injected into every session), plus narrower docs like `AVATAR-BRAIN.md`, `AI_ML_ROADMAP.md`, `BRAIN_BENCHMARK.md`, `JARVIS-INTEGRATION.md`.
- **Root-level vision docs — `haptics.md`, `build-mode.md`, `tools.md`, `do-after-3d-space-enviroment.md`** — design/planning documents for a not-yet-built "Full Dive" 3D spatial UI (a "string-grid" you could grab, place, and decorate panels in, plus webcam hand-tracking). These describe a future evolution of `space.html`, not code that exists yet — `space.html` currently only has an early "hand cursor (webcam haptics)" comment as a starting point, confirmed by grepping for the concepts (`string-grid`, `build-mode`) in the actual runtime code and finding nothing beyond that one comment.
- **`README.md`** — the project's public-facing one-paragraph pitch. **`Nyxia.desktop`** — a Linux desktop-shortcut file so the app shows up like a normal installed program. **`Nyxia.modelfile`** — an older, unused-looking Ollama Modelfile variant (see the `*.Modelfile` family under "The training ground" above).
- **`.planning/`, `.oldmds/`, `Claude session resume/`** — archives: past planning documents, superseded doc versions, and a saved link to resume a prior Claude web session.
- **`scripts/migrate-to-lancedb.js`, `scripts/benchmark_brain.py`** — one-off/maintenance scripts (a past migration into LanceDB; a brain-performance benchmark).
- **`.mcp.json`** — configuration for developer-tooling MCP servers (like `claude-flow`) used while *building* Nyxia with Claude Code — not something Nyxia herself uses at runtime.
- **`node_modules/`, `.git/`** — standard dependency and version-control folders, intentionally not explored file-by-file for this document.

## How To...

- **Add a new avatar emotion or animation** → add the clip in Blender (via `blender_scripts/`, exporting through `03_export_glb.py`/`03b_export_glb_single.py`), regenerate `nyxia-anims.glb` with `extract-anims.js`, then add the emotion to `ANIM_MAP`/`EXPR_MAP` in `src/avatar-brain.js` and, if it needs a new bone mapping, `MIXAMO_TO_VRM` in `src/desktop-avatar.html`.
- **Change how she decides what to say (personality, tone, memory weighting)** → start in `src/prompt-builder.js` (assembles the prompt) and `docs/STARTUP_MEMORY.md` (her core persona text). For *which brain* answers, look at `src/llm/router.js` (mode classification) and `src/llm/adapter.js`/`src/llm/providers.js` (which API gets called).
- **Fix or change 3D rendering / the avatar looking wrong (T-pose, wrong pose, missing animation)** → `src/desktop-avatar.html`'s retargeting code (`retargetMixamoToVRM`, `SRC_REST`, `ARM_REST_OFFSET`) is almost always the culprit; check the console log line `[desktop-avatar] bone map: X/19 bones mapped` first to see if bones are even matching.
- **Add a new memory type or change what she remembers** → `src/memory-manager.js` is the entry point; add a new source there and in one of `src/lance-memory.js` (similarity search), `src/graph-memory.js` (relationships), or `src/krix-memory.js` (cross-project).
- **Give her a new tool/ability she can call herself** → add it in *both* `src/nyxia-tools.js` (Claude/Anthropic format) and `src/agent-loop.js`'s `TOOL_SCHEMAS` (Ollama format) if it should work regardless of which brain is active, and wire the actual implementation into the `runTool`/`executeTool` dispatcher in each file.
- **Give her scoped access to a new claude-bridge tool** (something checked against `krix-brain/agents/nyxia.yaml`'s `tool_scope`, not a fully local tool) → add the tool name to her `tool_scope.tools` list (and, for path-taking tools, make sure the path falls under `tool_scope.paths`), then add a thin wrapper in `src/bridge-client.js` calling `claude-bridge`'s `POST /mcp`, and wire it as a dep the same way `bridgeOpenFile`/`bridgeReadFile`/`bridgeListFiles` already are. See `krix-brain/AGENT_TOOL_SCOPE.md`.
- **Change or add a TTS/voice option** → `src/tts/servers.js` (process lifecycle/ports) and `src/tts/pipeline.js` (how text gets split and dispatched); the actual voice models are the standalone Python scripts in the project root (`kokoro_server.py`, `xtts_server.py`, `qwen3_tts_server.py`, `chatterbox_server.py`).
- **Debug a background service not starting (Chroma, Ollama, reflex, SearXNG, KRIX-BRAIN)** → `src/service-startup.js` and `src/services/` — each has an `ensureX()` function that checks a health endpoint first, then spawns the process if needed, and logs via `src/utils/logger.js`.
- **Add a new "sense" (something she notices about the world)** → `src/mind.js` is the core event emitter; smaller senses live in `src/awareness/` (heartbeat/proactive/self-model) and the various single-purpose files listed under "extended cognition" above.

## Depends On

- **Anthropic Claude API** — primary cloud "voice," model `claude-sonnet-4-6`; falls back to a local OAuth proxy (`claude-bridge`, port 3456) if no API key is set, reusing an existing Claude subscription login instead.
- **Optional cloud AI providers** (for "the Council" and alternate voices) — Google Gemini, Groq, Mistral, xAI Grok, DeepSeek, Moonshot/Kimi — all accessed through OpenAI-compatible endpoints.
- **Ollama** (local AI model server, port 11434) — runs Nyxia's own fine-tuned model (`nyxia-ft`), the vision model (`qwen2.5vl:7b`), and small utility models (`llama3.2:3b`, `qwen3:8b`) for classification, emotion detection, and self-modeling.
- **ChromaDB** (local vector database server, port 8769) — stores "brain sector" beliefs, spoken to only via raw HTTP.
- **LanceDB** (embedded vector database, via the `vectordb` npm package) + **`@xenova/transformers`** — runs the `all-MiniLM-L6-v2` embedding model locally to power episodic/reflection memory search.
- **Kùzu** (embedded graph database, npm package `kuzu`) — relationship/connection memory.
- **KRIX-BRAIN** — Kristian's separate, larger personal knowledge system, reached over HTTP (API on port 7421, a "brain-core" neural layer on port 7422) for cross-project long-term memory.
- **SearXNG** — a self-hosted, privacy-respecting search engine run as a Podman container (port 8888), used for all web search.
- **Whisper** — local speech-to-text (the "tiny" model).
- **TTS engines** — Qwen3-TTS, Kokoro, and Chatterbox/XTTS (all local, GPU/CPU), with ElevenLabs (cloud, paid) as the final fallback.
- **Nengo** — a Python spiking-neural-network simulation library powering the experimental "reflex layer" mood simulator.
- **Three.js** + **`@pixiv/three-vrm`** — 3D rendering and VRM humanoid avatar support in the browser windows.
- **Blender 5.1** — offline 3D modeling, rigging, and animation-export tool (not used at runtime).
- **Playwright** — browser automation for the `browser_action` tool.
- **`node-pty` / `xterm`** — an embedded real terminal inside the app's UI panels.
- **Unsloth** — a fine-tuning acceleration library used to train Nyxia's own local model via QLoRA.
- **Electron 28.3.3** — the desktop application shell everything runs inside.
- **`nyxia-vessel.service`** (a `systemd --user` background service, confirmed active/enabled on this machine) — runs `nyxia-vessel.js` independently of Electron so Nyxia can "notice" time passed while the app itself was closed.

## Rough Edges

These are things actually found while reading the code, not guesses:

- **Docs and code disagree about which window is "the" main window.** `CLAUDE.md` and `docs/CONTEXT.md` both describe `combined.html` as the current combined chat+avatar window. In the real code, `src/window-manager.js`'s `createCombinedWindow()` loads **`space.html`**, not `combined.html`. `combined.html`, `index.html`, and the standalone `chat.html` window are still fully defined (`createCompanionWindow`/`createChatWindow` exist in `window-manager.js`) but **are never called** anywhere in `main.js`'s startup — they appear to be superseded, unremoved legacy UI.
- **The dev hot-reload watcher still targets the old windows.** `main.js`'s file-watcher (near the bottom) reloads on changes to `combined.html`, `chat.html`, or `index.html` — editing the actual live windows, `space.html` or `desktop-avatar.html`, triggers no reload at all.
- **`src/avatar-brain.js` mixes live code with old scaffolding.** The real, used parts (`analyzeEmotion`, `NyxiaAvatarController`) sit in the same file as an apparent early prototype (`initNyxiaAvatar`, `sendMessageWithAvatar`) that calls the Anthropic API directly from a renderer with a hardcoded model string and loads Three.js's `GLTFLoader` from a CDN URL — a pattern the rest of the app has moved away from.
- **The VRM retargeting math is hand-tuned to one specific model export.** `src/desktop-avatar.html` hardcodes quaternion rest-pose values (`SRC_REST`) read off one specific `Nyxia3dV2.glb` export, plus a manually-derived `ARM_REST_OFFSET` correction for the mismatch between that rig's arms-down rest pose and the VRM's T-pose rest. Swapping in a different base rig or VRM will likely require re-deriving these by hand; this is called out directly in the code's own comments.
- **A confirmed, but accepted, visual gap:** per `docs/CHANGES.md` (2026-07-01), the `surprised` expression has no matching facial blendshape on the current VRM model — the body animation plays but the face doesn't change. Logged as cosmetic, not fixed.
- **Two different avatar files loaded by two different (one dead, one live) windows.** The unused `index.html` loads `vrm_girl.vrm`; the live `desktop-avatar.html` loads `girl_character2_test.vrm`. Consistent with the dead-window issue above, but worth knowing if editing avatar-related code.
- **The reflex/mood Python service has a recent history of real bugs**, per `docs/CHANGES.md`: it silently hung forever due to a broken ROCm-reports-as-CUDA device check (fixed by forcing CPU), a Nengo matrix-shape mismatch, and — until fixed on 2026-07-01 — `main.js` never killed the process on quit, leaving zombie instances pinning a CPU core at 100%. Worth treating this service as the most fragile part of the stack.
- **Fixed (2026-08-06, Prompt D reconciliation): tool definitions are no longer hand-duplicated.** `src/tool-schemas.js` is now the single source of truth for the tools both brains share (shell, web search, fetch page, fs_read/fs_write/fs_list, browser_action, and the three `bridge_*`/`open_file` harness-scoped tools) as one format-agnostic `{name, description, parameters}` list, converted to Anthropic's `input_schema` shape by `toAnthropicFormat()` and Ollama's `{type:'function', function:{...}}` shape by `toOllamaFormat()`. `src/nyxia-tools.js` and `src/agent-loop.js` each `require()` it and layer their own brain-only tools on top — SELF tools (`set_mood`/`fire_brain`/`show_thought`) in `nyxia-tools.js`, `desktop_action` in `agent-loop.js` — in the same shape, run through the same adapters. The two files were **not** merged into one (they're genuinely different wire formats for two different consumers — Claude tool-use vs. Ollama function-calling — not accidental duplication of the same format), only the metadata that used to be hand-copied between them. By the time this was extracted, `shell`/`web_search`/`fetch_page`/`fs_write`/`browser_action` had already drifted to different wording between the two copies — concrete proof the duplication was a real, not theoretical, risk. `runTool`/`executeTool` (the two dispatchers) are untouched; each tool name in the generated arrays still matches a `switch` case in its own file.
- **Fixed (2026-08-06, same-day follow-up): `fs_read`/`fs_list` now go through the same scope check as `bridge_read_file`/`bridge_list_files`.** `main.js` binds `fsReadFile`/`fsListDir` to `bridgeClient.bridgeReadFile`/`bridgeListFiles` instead of `tools.js`'s local, unrestricted implementations — one binding point, no second enforcement path. This also closed two bypasses that weren't even tool-calls: `ipc/chat.js` and `api-server.js` each had a classifier-triggered `mode === 'filesystem'` branch that read/listed a regex-extracted path directly with zero scoping, sharing the same underlying functions — fixed for free by the same change. `fs_write` was deliberately left alone (not in Nyxia's declared `tool_scope`; see the `shell` entry below for why). See `krix-brain/AGENT_TOOL_SCOPE.md`'s "Fixed since first build" section for the live verification.
- **`shell` (and its `mode === 'shell'` twin in `ipc/chat.js`) is a real, more powerful, still-open version of the same gap.** It runs arbitrary commands with no per-agent path scoping — `cat`-ing any file under `/var/home/kvoldnes` works regardless of `tool_scope.paths`, confirmed live against a safe non-sensitive target during the `fs_read`/`fs_list` fix's verification. Unlike a path argument, a command string can't be scoped by a directory-prefix check — closing this means either dropping `shell`/`run_command` from Nyxia's live toolset or building real command sandboxing. `fs_write` shares this untouched status for the same structural reason. See `krix-brain/AGENT_TOOL_SCOPE.md`'s "Known gaps" section.
- **`nyxia-ft` (the model `agent-loop.js` is hardcoded to via `AGENT_MODEL`) doesn't reliably emit real tool calls.** Confirmed directly against Ollama's `/api/chat`: given a valid `tools` array, it responds with prose describing what it *would* do instead of an actual `tool_calls` entry — `qwen3:8b` handles the identical prompt correctly. This affects every tool in `agent-loop.js`, not just the new ones. `runAgentLoop()` now takes an optional `model` param (default unchanged) so this can be worked around for testing; swapping or retraining the production model is a separate, unstarted task.
- **A literal folder named `{src,assets,backend,docs}`** sits in the project root — almost certainly a shell brace-expansion typo (a `mkdir {src,assets,backend,docs}`-style command run without expansion support) that created one folder with that exact name instead of four separate ones.
- **`training-data/` and `training_data/`** exist side by side as two separate folders for what looks like the same purpose (fine-tuning datasets) — easy to update the wrong one.
- **The project's on-disk size is dominated by fine-tuning artifacts, not app code** — multiple multi-gigabyte `.gguf` model files, a full `nyxia-merged/` safetensors checkpoint, and two training-data folders live directly in the project root. `.gitignore` was patched (2026-06-09) to keep ~50GB of this out of git, but it's still all sitting in the working directory.
- **`godot-mcp/`** contains only an empty `logs/` folder, and **`3dspace/`** contains only a near-empty subfolder — both read as abandoned or never-finished experiments rather than active parts of the system.
- **`chromadb` is still in `package.json`'s dependencies** even though `src/brain-soul.js`'s own comments say never to `require()` it directly (it breaks Electron's module loader) — it's kept installed but deliberately unused at the code level.
