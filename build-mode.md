# Nyxia — Build Mode

> Companion to `haptics.md`. Build mode is the **placement / authoring layer** for inhabiting Nyxia's space — flooring, walls, props, decoration. Haptics is the *input grammar*; build mode is what those inputs author. Keep them separate concerns: haptics works in build OR live mode, build mode is a state you enter.

---

## Core concept — the **string-grid**

Instead of a flat editor grid, the buildable substrate is a **3D lattice of luminous strings** — a tamed Calabi-Yau weave. The grid is **diegetic**: it is part of Nyxia's universe, not editor chrome.

```
  ┊ ┊ ┊ ┊ ┊ ┊ ┊        ← volume strings (sparse, 3D)
  ╳━╳━╳━╳━╳━╳━╳━╳     ← floor weave (dense, XZ plane)
  ┃   ┃   ┃   ┃        ← wall strings (rise at active edges)
```

Three layers, one lattice:

| Layer | Purpose | Visibility |
|---|---|---|
| **Floor strings** | Horizontal weave on XZ, the canonical floor grid | Dense; build mode = full brightness, live mode = whisper-faint |
| **Wall strings** | Vertical sheets rising from floor edges | Only appear at active edges; brighten near cursor |
| **Volume strings** | Sparse 3D lattice for levitating objects | Always faint; pluck on placement |

**The lattice is always there.** Build mode just turns the lights up.

---

## Why strings, not a grid

- **Diegetic** — the grid is the universe's substrate, not a tool overlay. You never break aesthetic mode.
- **Attention-aware** — strings render densely only near the cursor. A 100×100m buildable area costs almost nothing because most of it is faint.
- **Sensor feedback built-in** — strings *pluck* when you approach with a placeable. Brightness + ripple = the grid telling you where it's listening.
- **Nyxia can play it** — she plucks strings idly, the whole lattice resonates when she's deep in thought. The build space and the AI share an instrument.
- **Vocabulary scales** — "tuning a room", "string library", "harmonic placement", "dissonant pieces". The metaphor writes itself.

---

## Interaction model

Build mode is a **toggle** (suggested: `B` key, or a button in the handheld terminal's CONFIG tab).

| State | What strings look like | What you can do |
|---|---|---|
| **Live mode** (default) | Whisper-faint, only volume strings vibrate when haptic-grabbed objects pass through | Drag panels, chat, normal Full Dive |
| **Build mode** | Strings light up across buildable radius; cursor reticle snaps to nearest intersection | Place / edit / delete pieces |
| **Edit mode** (sub-state of build) | Selected piece shows gizmo; strings around it brighten | Move, rotate, scale, recolor |

### Cursor in build mode
- Reticle = small holographic crosshair that **snaps to nearest string intersection**
- Pluck animation on snap (one-shot ripple from that vertex)
- Hover-near radius ~3m brightens strings; outside that they're at 5% opacity
- Right-click in empty space = quick palette (recent pieces)
- Held cursor over a placed piece = edit mode for that piece

### Placement flow
1. Open piece library (`B` → toggles build mode and opens palette)
2. Pick a piece — cursor becomes a ghost preview of it, snapped to nearest string vertex
3. Mouse along the lattice — preview teleports vertex-to-vertex with a soft pluck on each
4. Click — piece materializes (string nearest the placement plays a one-shot bright ripple, like a guitar string struck)
5. Right-click during placement = rotate 90° on the relevant axis
6. `Esc` = cancel

### Wall sensors
- Each placed floor tile registers its 4 edges as **wall seats** (eligible vertical lattice)
- Hover a wall piece → the seats nearest your cursor light up as vertical string sheets rising from those edges
- Click → wall snaps in; the strings stay as the wall's skeleton, the wall mesh layered over

---

## Piece library — three sources, one aesthetic

### Tier 1 — Native primitives (ship first)
Geometric pieces that match the existing blueprint/wireframe DNA. All `LineSegments` based, all emissive.

- **Floors:** hex tile, square plate, perforated grate, scanline disc, mesh platform
- **Walls:** lattice screen, glass-pane (transparent + edge-glow), perforated panel, archway, doorway frame
- **Pillars:** simple, fluted, knotwork, signal-mast, light-tower
- **Light:** strip (linear), emitter (point), beacon (vertical column), nebula patch (decorative)
- **Plinths:** glyph plinth, hologram pedestal, low table

Build these natively in Three.js. ~25 pieces is plenty to start.

### Tier 2 — Curated GLTF library (ship after Tier 1 lands)
~20-30 hand-picked models from CC0 sources (Quaternius, Kenney). Furniture, plants, instruments, bookshelves, lamps. Each runs through a **Nyxia styling shader pass** so they read as *holographic versions* of themselves, not polygon mismatches:

- Flatten textures
- Push to emissive on edges (Sobel pass on UVs, or `EdgesGeometry` overlay)
- Fresnel rim glow in cyan/purple based on category
- Subtle scanline overlay matching the rest of the scene

Without this pass, dropped-in models will look cheap. **Do not skip it.**

### Tier 3 — Parametric rooms (deferred — Nyxia as architect)
"Build me a library" / "give me a study" → procedural generator using Tier 1 + Tier 2 to lay out a room. User refines by hand. This is the *magical* end-state. Don't build until Tier 1+2 are solid.

---

## Technical sketch

### String-grid shader

Single `LineSegments` mesh covers the whole buildable region. Vertex shader handles vibration + cursor proximity:

```glsl
// vertex
uniform float uTime;
uniform vec3  uCursorWorld;
uniform float uBuildModeAmount; // 0 = live, 1 = build
varying float vGlow;

void main() {
  vec3 p = position;
  // breathing ripple
  p.y += sin(uTime * 2.0 + position.x * 0.6 + position.z * 0.5) * 0.012;
  // cursor proximity glow
  float d = distance(p.xz, uCursorWorld.xz);
  vGlow = mix(0.05, smoothstep(3.0, 0.0, d), uBuildModeAmount);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}

// fragment
varying float vGlow;
uniform vec3 uColor; // 0x00d4ff
void main() {
  gl_FragColor = vec4(uColor, vGlow);
}
```

- `uBuildModeAmount` is animated 0→1 / 1→0 over ~400ms when toggling
- Two uniforms = whole grid responds to cursor + global state with one draw call

### Snap logic

```js
const SPACING = 0.5;          // metres between string intersections
function snapToLattice(world) {
  return new THREE.Vector3(
    Math.round(world.x / SPACING) * SPACING,
    Math.round(world.y / SPACING) * SPACING,
    Math.round(world.z / SPACING) * SPACING,
  );
}
```

The cursor reticle = `snapToLattice(cursorWorld)`. Cheap; runs every frame.

### Pluck animation

One-shot ripple originating from a vertex:

```glsl
// add to vertex shader
uniform vec3  uPluckOrigin;
uniform float uPluckTime;     // -1 = no pluck, else seconds-since-pluck

float dPluck = distance(position, uPluckOrigin);
float pluckWave = sin(uPluckTime * 12.0 - dPluck * 4.0) * exp(-uPluckTime * 3.0) * exp(-dPluck * 0.4);
p.y += pluckWave * 0.08;
vGlow += max(0.0, pluckWave) * 0.6;
```

JS sets `uPluckOrigin = snappedPos` and `uPluckTime = 0`, then animates `uPluckTime += dt` for ~1.5s, then resets to -1.

### Wall seat detection

Each placed floor piece registers its world-edges in a `Map<edgeKey, FloorPiece>`. When a wall piece is in placement preview, find candidate edges:

```js
const edges = floors.flatMap(f => f.edges); // 4 per floor
const sortedByCursor = edges.sort((a, b) => a.center.distanceTo(cursorWorld) - b.center.distanceTo(cursorWorld));
const candidates = sortedByCursor.slice(0, 4); // 4 nearest seats brighten
```

Drive a separate uniform array (`uActiveSeats[4]`) into a wall-string shader that lights up only those segments.

### Performance — InstancedMesh from day one

The current scene scales to ~50 panels. A built-out room is hundreds of pieces. **Every piece in the library should be backed by an `InstancedMesh`** keyed on piece-type:

```js
const floorInstances = new THREE.InstancedMesh(floorTileGeo, floorTileMat, 1024);
let floorCount = 0;
function placeFloor(world) {
  const m = new THREE.Matrix4().makeTranslation(world.x, world.y, world.z);
  floorInstances.setMatrixAt(floorCount++, m);
  floorInstances.instanceMatrix.needsUpdate = true;
}
```

One draw call per piece type, no matter how many copies. Same trick for walls, pillars, lights. Buys 10× headroom. **Do this from the first commit** — refactoring later is painful.

---

## Save format

Build state is a flat JSON list of placed pieces:

```json
{
  "version": 1,
  "pieces": [
    { "id": "p_001", "type": "floor.hex", "pos": [0, 0, 0], "rot": [0, 0, 0], "tint": null },
    { "id": "p_002", "type": "wall.lattice", "pos": [0, 0, 1], "rot": [0, 1.5708, 0], "anchor": "p_001:edge_n" },
    { "id": "p_003", "type": "prop.lamp", "pos": [0, 1.2, 0.5], "rot": [0, 0, 0] }
  ]
}
```

- `id` = stable, generated on place
- `type` = "category.piece" — maps to the library
- `anchor` = optional, links walls to floor edges so deleting a floor warns about its walls
- Persist via the same backend hook as haptic positions (suggested: `PATCH /space/layout`, debounced 800ms after last edit)

---

## UI surfaces (build mode)

### Piece palette
Bottom-strip drawer (slides up from below depth-bar when build mode opens). Tabs: **floors / walls / pillars / light / props / library**. Each tab is a horizontal row of thumbnails (rendered live from the piece geometry into a small offscreen canvas). Drag a thumbnail into the scene to start placement.

### Build HUD chip
Replaces or augments the SPATIAL-OS chip when in build mode:
```
▣ BUILD-MODE   PIECES 47   GRID 0.5m   B • exit
```

### Edit gizmo
Selected piece shows three colored axes (cyan X, green Y, purple Z) with drag handles. Same haptic drag pattern as panels. Right-click selected = context menu (duplicate / delete / recolor / pin).

### Undo
`Ctrl+Z` / `Cmd+Z` — keep a stack of the last 50 operations. Place / move / delete / rotate are all reversible. Critical UX, do not ship build mode without it.

---

## Phasing — recommended

| Phase | Scope | Effort |
|---|---|---|
| **0** | Add `Tier 1` library structure + place/rotate/snap on a basic flat grid | small |
| **1** | Replace flat grid with **string-grid shader** (floor weave only); add pluck animation | medium |
| **2** | Wall seats + vertical string sheets; full Tier 1 piece set; undo stack | medium |
| **3** | Save/load (JSON), per-room presets, palette UX polish | small |
| **4** | Tier 2 — curate 20 GLTF models + Nyxia styling shader pass | medium |
| **5** | Tier 3 — parametric room generator with Nyxia as co-architect | large |

Phases 0-3 are a complete, shippable build mode. 4 makes it luxurious. 5 is the magical end-state — defer until 0-4 are mature.

---

## What couples build mode to haptics

The two systems are separate concerns but share infrastructure:

- **Same grab/drag math** — `pointerToWorld(mx, my, depthPoint)` in haptics works identically for moving placed pieces in edit mode. Don't duplicate.
- **Same long-press radial pattern** — long-press a placed piece = radial with edit/duplicate/delete/recolor.
- **Same toast / chip styling** — visual contract from `haptics.md` applies.
- **Same `spawnNode`-style API** — placing a piece is structurally the same as spawning a panel. Consider a unified `spawn(kind, data, position)` underneath.

---

## What stays separate

- **Mode toggle** — build mode is an explicit state, haptics is always-on. Don't let build chrome leak into live mode.
- **Save scope** — haptic panel positions are session state; build pieces are persistent canvas state. Different endpoints.
- **Undo** — build mode has full undo; haptic drags do not (and shouldn't, that would be annoying for ambient panel rearranging).
- **Permissions / multiplayer (future)** — if you ever share a space, build state needs ownership/locking; haptic state is per-viewer.

---

## Visual contract additions

On top of the existing palette in `haptics.md`:

- **String color** = `#00d4ff` at low opacity (matches primary). Volume strings get a faint `#c084fc` tint at intersections.
- **Pluck flash** = `#9bf2ff` (lighter cyan) for one frame, fades back to base
- **Reticle** = same corner-bracket pattern as `.hud`, scaled to ~24×24px in screen space (raytrace from world snap-pos to screen, draw via Canvas2D overlay)
- **Wall seat highlight** = vertical string sheet at full brightness with subtle vertical scroll (texture offset animating upward)
- **Edit gizmo** = matches blueprint aesthetic — thin lines, small caps, 1.5px stroke

---

## Open questions for later

1. **Boundaries** — is the buildable region infinite or fenced (e.g. 50×50m)? A fence gives the room a horizon; infinite gives freedom.
2. **Gravity / physics** — do placed pieces obey gravity, or float? Recommend: floors+walls are anchored, props can be either (toggle per piece).
3. **Lighting** — does Nyxia's avatar receive light from placed lamps? If yes, real-time GI is too expensive; bake or use a simple light-probe per lamp.
4. **Multi-room** — single canvas or named rooms (study / lab / observatory) with portals between?
5. **Nyxia's input** — when she "places" via chat, does she go through the same API as the user, with a visual cue (her cursor, her color)?

These are good design conversations to have before phase 5, but don't block phases 0-3.

---

## File map (proposed)

```
3d-environment.html         (live scene + haptic layer + terminal)
build/
  string-grid.glsl          (vertex + fragment shaders)
  pieces/                   (Tier 1 native piece geometries)
  loaders/styling-shader.js (Tier 2 GLTF restyling pass)
  palette.jsx               (piece library UI)
  save-load.js              (JSON serialization)
build-mode.md               (this file)
haptics.md                  (input grammar — separate concern)
```

When build mode lands, integrate into `3d-environment.html` via a top-level toggle and lazy-load the `build/` modules so live mode stays light.
