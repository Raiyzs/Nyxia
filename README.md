<p align="center">
  <img src="assets/banner.svg" alt="Nyxia" width="900"/>
</p>

An Electron-based desktop AI companion with a 3D avatar, local voice, persistent memory, and awareness of your system.

**End goal:** A fully local AI companion that integrates with your desktop and OS — always present, always aware, genuinely yours.

---

## Requirements

- **Node.js** v20+ (v24 recommended via nvm)
- **Python** 3.10+
- **Ollama** — [ollama.ai](https://ollama.ai) with the following models pulled:
  ```
  ollama pull llama3.2:3b
  ollama pull qwen3:8b
  ollama pull qwen2.5vl:7b
  ```
- **API key** — Anthropic (Claude) required. Others optional (ElevenLabs, Gemini, Groq, Mistral).

---

## Install

```bash
git clone https://github.com/Raiyzs/nyxia.git
cd nyxia
npm install
```

Install Python dependencies for the TTS servers:

```bash
pip install --user kokoro-onnx sounddevice numpy flask
```

---

## Run

```bash
./launch.sh
```

Or:

```bash
npm start
```

The launch script starts Ollama if it isn't running, then launches the app.

---

## API Keys

Set your keys inside the app under **Settings** (gear icon). No `.env` file needed — keys are stored locally in your user config directory and never touch the project folder.

---

## Features

- 3D animated avatar driven by emotion detection
- Local voice via Kokoro TTS (no internet required)
- Voice input via Whisper STT
- Persistent semantic memory (LanceDB + Kùzu graph)
- System awareness — clipboard, active windows, screen, files
- Agent loop with tool use (search, shell, browser, filesystem)
- Multi-provider support — Claude, Gemini, Groq, Mistral, Ollama
- PWA companion interface for phone

---

## 3D Full Dive Space (`src/space.html`)

An experimental Three.js environment where Nyxia inhabits a holographic 3D space. Panels float around her avatar, can be grabbed/thrown/inspected with haptic-style mouse input, and the scene reacts to her mood.

**Haptic spatial layer** — always on:

- Grab, throw with momentum, long-press radial menu (inspect / pin / link / clone / delete)
- Panel connection lines auto-drawn to central KRIX node
- Spawn panels (`N`), reset (`R`), toggle terminal (`T`)

**Build mode** (`B` key) — spatial authoring backed by a luminous string-grid shader:

- String-grid floor weave with cursor proximity glow and pluck ripple (GLSL ShaderMaterial)
- Snap-to-lattice placement at 0.5m intersections
- Wall seats — vertical string sheets rise at active floor edges when placing walls
- Tier 1 pieces: square floor, hex floor, lattice wall, pillar, light strip
- InstancedMesh for all piece types — one draw call per type regardless of count
- Karplus-Strong pluck synthesis (inline Web Audio, no CDN)
- Undo stack (`Ctrl+Z`) for all placement operations
- Visual contract: cyan `#00d4ff`, purple `#c084fc`, `AdditiveBlending`, no PBR, no rounded chrome
