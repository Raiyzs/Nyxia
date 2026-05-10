# Nyxia — Tools, Plugins & Working Rules

> The project's constitution. Read this first, every time. Companion to `haptics.md` and `build-mode.md`.

---

## What this project is

A 3D "Full Dive" environment for **Nyxia**, an AI companion. Built in Three.js (v0.183.2, ES module via importmap). Single HTML file currently — `3d-environment.html`. Will eventually grow modular.

Three concepts coexist:
- **Live mode** — ambient scene, panels float, avatar present
- **Haptic layer** — direct manipulation of panels (drag/throw/spawn/radial). Always on.
- **Build mode** — string-grid authoring of floors/walls/props. Toggleable state. *(planned)*

Read `haptics.md` and `build-mode.md` for the deep spec on each.

---

## Visual contract — DO NOT VIOLATE

**Palette**
- Primary cyan `#00d4ff` (rgba 0,212,255) — original chrome, links, HUD
- Accent purple `#c084fc` (rgba 192,132,252) — hover, spawned, mood
- Success green `#4ade80` — status pings only
- Background near-black `#010006`
- One-frame pluck flash `#9bf2ff`

**Type**
- **Syne** — display, all-caps, letter-spacing 2-3px
- **DM Sans** — UI body
- **monospace** — data values, log entries

**Geometry**
- 1px solid borders, opacity 0.3-0.7
- Corner brackets via `linear-gradient` `*-no-repeat` tricks (see `.hud`, `#handheld`)
- **Chamfered corners** via `clip-path: polygon(...)` — never `border-radius` on chrome
- Scanlines via `repeating-linear-gradient` at 0.08-0.24 opacity
- Glow via layered `box-shadow: 0 0 Npx rgba(0,212,255,0.2)` + a subtle `filter: brightness(1.06)` on the main canvas

**Three.js**
- All accent geometry is `LineSegments` from `EdgesGeometry` — wireframe-first, never solid PBR
- `MeshBasicMaterial` with `blending: AdditiveBlending` for glow
- `LineDashedMaterial` for connection lines (always `computeLineDistances()` after rebuild)
- No shadows, no ambient occlusion, no PBR — the aesthetic is holographic

When adding new UI/geometry, match these. **Never invent a new color or radius.**

---

## What NOT to do

These are tempting and wrong. Bookmark this list.

- **No Tailwind** — the visual vocabulary is hand-rolled and intentional
- **No npm dependencies casually** — importmap keeps it light; vet additions
- **No PBR materials, no shadows, no realistic lighting** — kills the holographic aesthetic
- **No `border-radius` on chrome** — chamfered `clip-path` only
- **No emoji** — unless explicitly part of brand (it's not)
- **No filler content** — every element earns its place; if a section feels empty, design problem to solve with composition
- **No rounded corners + left-border accent containers** — that's AI-slop UI
- **No gradient backgrounds aggressively** — subtle only
- **No new fonts** — Syne, DM Sans, monospace
- **No realistic icons that aren't drawn from SVG** — placeholders > bad attempts
- **No `scrollIntoView`** — breaks the app
- **No new colors** — pull from the palette above

---

## Architectural rules

- **InstancedMesh from day one** for repeated build pieces (every floor tile, every wall segment is one draw call)
- **Single shared materials** where possible — don't allocate per-object
- **`THREE.LineDashedMaterial` requires `computeLineDistances()`** after geometry change
- **Raycast targets only the body mesh, not the border** (`clickables` array)
- **Panel rotation tracks border** during haptic drag (the bug we already fixed — don't re-introduce)
- **Live mode and build mode share the haptic input layer** — don't duplicate `pointerToWorld`, drag math, long-press timer
- **Build state persists, haptic state is session** — different endpoints, different lifecycle

---

## File layout (current + planned)

```
3d-environment.html         live scene + haptic layer + terminal (current monolith)
haptics.md                  haptic input grammar + Claude Code hand-off
build-mode.md               string-grid build mode spec + phasing
tools.md                    THIS FILE — constitution
colors_and_type.css         legacy token sheet
README.md                   project intro
docs/                       reference material
ui_kits/                    misc design references
build/                      (planned)
  string-grid.glsl
  pieces/
  loaders/styling-shader.js
  palette.jsx
  save-load.js
audio/                      (planned — see Tone.js below)
```

---

## Tooling — what to install / set up

### Tier 1 — get these now

| Tool | Why | How |
|---|---|---|
| **three-devtools** (Chrome ext) | Inspect scene graph live; find hidden/broken meshes | Chrome web store |
| **Stats.js** | FPS + draw call count overlay | `import Stats from 'three/examples/jsm/libs/stats.module.js'` — drop in |
| **gltf.report** | Validate/optimize GLTF assets before importing | Web bookmark — drag GLTF in |
| **CLAUDE.md / tools.md** (this file) | Project constitution every chat reads | Already done ✓ |

### Tier 2 — when past prototyping

| Tool | Why |
|---|---|
| **ESLint + Prettier** | Stop arguing about style, argue about substance. Strict config. |
| **Vitest** | Test the math (snap, save/load, edge-detection) — not the visuals |
| **Shadertoy** / **Compute.toys** | Iterate shaders OUTSIDE the app, port when ready. Massive workflow upgrade for build-mode shaders. |
| **Storybook** or **Ladle** | When components modularize — iterate handheld/palette/gizmo without booting Three.js |

### Tier 3 — elevation tier

| Tool | Why |
|---|---|
| **Tone.js** | Ambient hum, pluck on placement, chime on terminal-open. The string-grid CONCEPT begs for sound. Single biggest perceived-quality jump available. |
| **Blender** | Author custom Tier 1 build pieces, export to GLTF |
| **Annotated screenshot library** (in `docs/`) | Visual references Claude Code can match against, not just descriptions |
| **Scene snapshot command** | Press key → save camera+panels+build state to JSON. Reload anytime. Built in ~30 lines. |

### What NOT to bother with on this project

- **Figma** — too code-driven for round-trips to help
- **shadcn / MUI / any component library** — fights the hand-rolled aesthetic
- **TypeScript right now** — premature for a single fast-moving file. Add when modularizing.
- **Redux / Zustand** — state is small, plain objects + save/load fn are fine

---

## Claude Code hand-off rules

When asking Claude Code to work on this project, always:

1. **Point them at this file first.** Then `haptics.md` if haptic-related, `build-mode.md` if build-related.
2. **State the visual contract is non-negotiable** — don't let them "improve" it with rounded corners, new colors, or PBR.
3. **Specify the layer they're working in** — live / haptic / build / terminal. Each has different rules.
4. **Demand `InstancedMesh` for repeated geometry** in build mode from the first commit.
5. **Require `computeLineDistances()`** after any dashed-line geometry rebuild.
6. **Persist via the existing chip metaphor** — when adding state, surface it in the SPATIAL-OS chip or handheld terminal, not new chrome.
7. **Match motion timing** — pop-in 420ms ease-out cubic, long-press 520ms, toast fade 300ms. Centralize in a constants file when modularizing.
8. **No new dependencies without justification.** Importmap stays slim.

---

## Performance budget

| Metric | Target | Hard limit |
|---|---|---|
| Draw calls | < 80 in live mode | < 200 with full build |
| Triangles | < 100k | < 500k |
| FPS (desktop) | 60 | 30 |
| FPS (mobile) | 45 | 24 |
| Bundle size (HTML+JS, no GLTF) | < 80KB | < 200KB |

Stats.js gives you draw calls + FPS. Watch them weekly.

---

## Communication patterns (for AI co-development)

When Claude Code (or anyone) submits work, the review checklist:

- [ ] Visual contract held? (colors, fonts, no rounded corners, no emoji)
- [ ] Right layer? (didn't bleed build chrome into live mode, etc.)
- [ ] Performance? (Stats.js shows no FPS drop, draw calls reasonable)
- [ ] Reusable? (used existing helpers like `pointerToWorld`, `mkL`, `bpTex` — didn't reinvent)
- [ ] Documented? (if it's a new system, added to the relevant `.md`)
- [ ] Reversible? (build mode only — undo stack updated)
- [ ] No new dependency? (or justified one)

---

## Open architectural decisions

These are unresolved and should be discussed before they ossify:

1. **Module split** — when does the monolith become `src/scene/`, `src/haptics/`, `src/build/`, `src/terminal/`? Suggest: when the file passes 1500 lines OR when build mode lands.
2. **Backend shape** — REST? WebSocket? Local-first with sync? The chat in the terminal is the first thing that needs a real backend.
3. **Multi-room model** — single canvas or named rooms with portals? Affects save format.
4. **Nyxia's avatar in 3D** — currently a 2D Canvas overlay. Does she become a full 3D entity (volumetric, point cloud, character)? Affects how build pieces light her, how she moves through space.
5. **Persistence ownership** — local-only? Cloud-synced? Per-user? Affects every save format decision.

Resolve before scaling, not after.

---

## Quick reference card

```
NEW UI → match .hud / #handheld pattern (corner brackets, chamfered, scanlines)
NEW PANEL → use spawnNode() API or extend it
NEW INTERACTION → goes in haptics.md
NEW BUILD PIECE → goes in build-mode.md, needs InstancedMesh
NEW BACKEND HOOK → list in the relevant .md's "Hand-off" section
NEW SOUND → add to audio.js (planned), follow ambient/pluck/chime taxonomy
NEW COLOR → no
NEW FONT → no
NEW DEPENDENCY → justify or no
```
