# Nyxia — Haptic Spatial Layer

> Living document. Implementation reference for `3d-environment.html` and a hand-off note for Claude Code when wiring real backends.

## What this is

A direct-manipulation layer over the Full Dive 3D scene. Panels float in 3D space around Nyxia's avatar (the central KRIX-BRAIN node) and can be **grabbed**, **thrown**, **spawned**, **deleted**, and **inspected** with mouse, touch, or device motion. Connection lines automatically draw between every panel and the central node.

The layer is **stateless and frontend-only** — it does not persist anything yet. Claude Code is expected to plug in:
- Real data into spawned nodes
- Persistence (positions, pinned state, custom panel content)
- The `link` action (currently a placeholder)
- Voice / advanced gesture input later

---

## Interaction model

| Input | Action |
|---|---|
| **Hover** panel | Highlight + cursor turns purple |
| **Tap** (click, no drag) | Open inspect detail card |
| **Click + drag** | Grab panel, follows cursor on a camera-facing plane at panel's depth |
| **Release while moving** | Throw with momentum (decays at 0.93/frame) |
| **Long-press** (~520ms, no movement) | Open radial menu: inspect / pin / link / clone / delete |
| **Mouse wheel / pinch** | Zoom depth (orbit radius) |
| **Mouse move** (no drag) | Camera orbit follows pointer |
| **Two-finger pinch** (touch) | Zoom depth |
| **Device tilt** (mobile gyro) | Parallax camera offset |
| **N** key | Spawn new node |
| **R** key | Reset all positions, remove spawned |
| **T** key | Toggle handheld terminal |
| **Esc** | Close any open panel/radial |

---

## Architecture

### Core arrays
```js
const panelObjs = [];   // [{mesh, brd, baseY, phase, mat, vel, pinned, spawned, data}]
const clickables = [];  // raycast targets — only the mesh, not the border
```

Every panel is **two meshes**: a `PlaneGeometry` with a generated blueprint texture (the body), and a `LineSegments` from `EdgesGeometry` (the border). The border tracks position **and rotation** of the body during drag.

### Central node
```js
const KRIX_POS = new THREE.Vector3(0, 1.4, 0);
```
Connection lines are drawn from each panel to `KRIX_POS`. When Claude Code wires the real KRIX-BRAIN orb, swap this constant for the actual mesh's world position (or pass a `getCenter()` callback).

### Drag math
```js
function pointerToWorld(mx, my, depthPoint) {
  // raycast a plane perpendicular to the camera, passing through the panel's current position
  raycaster.setFromCamera(ndc, camera);
  const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir);
  dragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), depthPoint);
  raycaster.ray.intersectPlane(dragPlane, out);
  return out;
}
```
This is the trick: the panel stays at its current depth from the camera, so the user feels like they're sliding it through the scene rather than projecting it onto an arbitrary plane.

### Throw physics
On `mouseup` we sample the last ~6 drag positions and compute velocity from the oldest/newest pair, scaled to per-second (`60/dt`). Each frame: `position += vel * 0.016`, then `vel *= 0.93`. Capped at `length 20` to keep panels in-scene.

### Long-press radial
A 520ms timer is set on `mousedown`. If the user moved less than 8px in that window, the radial menu opens at the cursor and the drag is cancelled. Otherwise the timer is consumed by the drag.

### Connection lines
A single `THREE.LineSegments` with a `LineDashedMaterial` covers every link. Rebuilt every frame in `updateLinks()`:
```js
function updateLinks() {
  const pts = [];
  panelObjs.forEach(p => { pts.push(p.mesh.position.clone(), KRIX_POS.clone()); });
  linkGeo.setFromPoints(pts);
  linkLines.computeLineDistances();   // required for dashed materials
}
```

---

## Public API surface

These are the functions Claude Code should hook into. They live in the closure of the module script in `3d-environment.html`. To call from outside, expose them on `window`.

| Function | What it does | Hook for |
|---|---|---|
| `spawnNode(data?)` | Creates a new panel near the avatar with pop-in animation | Wire real KRIX-BRAIN nodes / memories / agents |
| `resetSpatial()` | Restore originals, remove spawned | Optional: persist before reset |
| `openDetail(mesh)` | Open the right-side inspect card | Replace placeholder rows with live data |
| `openRadial(mesh, x, y)` | Show 5-spoke radial at screen coords | Add custom actions |
| `showToast(msg)` | Top-center sci-fi toast | Surface backend events |

### Recommended `data` shape for spawned nodes

```js
{
  id: 'krix-mem-0042',
  label: 'PANEL_θ',           // tiny corner stamp on the texture
  title: 'Conversation 042',  // bold header in inspect card
  rows: [                     // key/value pairs in the card
    ['Type', 'CHAT'],
    ['Tokens', '8.2k'],
    ['Stamp', '04:17'],
    ['Vector', 'cos 0.91'],
  ],
  tint: 0xc084fc,             // optional border color
}
```

---

## Hand-off — what Claude Code should wire

### 1. Replace placeholder spawn templates
In `spawnNode()`, the `SPAWN_TEMPLATES` array is dummy data (Architecture / Simulation / Custom). Replace with real KRIX-BRAIN queries:

```js
async function spawnNode() {
  const node = await fetch('/krix/spawn', { method: 'POST' }).then(r => r.json());
  // ... use node.label, node.title, node.rows
}
```

### 2. Persist positions
Currently positions are lost on refresh. Suggested: debounced PATCH to a `/spatial/layout` endpoint with `{id, x, y, z, pinned}` whenever a panel comes to rest (`vel.lengthSq() < 0.0001` and was just dragging).

### 3. Implement `link` action
The radial's `link` button currently just shows a toast. To wire:
1. On `link` click, set `linkSource = mesh`, change cursor color
2. Next click on a different panel = create edge
3. Add to a `userLinks: [{a, b}]` array and render alongside the auto KRIX links
4. Persist edge to backend

### 4. Real-time updates from backend
The chat `sendMessage()` currently uses a placeholder reply pool. Swap with:
```js
const reply = await fetch('/nyxia/chat', {
  method: 'POST',
  body: JSON.stringify({ text, sessionId })
}).then(r => r.json());
```
Stream tokens for the typing dots animation to feel right.

### 5. Voice / advanced gestures (future phase)
The current input system is centralized in `mousedown` / `mousemove` / `mouseup`. To add voice:
- Web Speech API for input → push transcribed text into `sendMessage()`
- TTS for replies → speak each `addMsg('nyxia', ...)`

For Leap Motion / WebXR hand tracking later: the **drag plane projection** is already abstract enough — replace `pointerToWorld()` with a function that returns world-space from a hand position, and `dragging` will follow the same way.

---

## Visual contract (for matching new UI to the scene)

- **Primary cyan** `#00d4ff` (rgba 0,212,255) — original panels, HUD, links
- **Accent purple** `#c084fc` (rgba 192,132,252) — spawned/clone panels, hover state, mood bars
- **Success green** `#4ade80` — status pings only
- **Background** `#010006` — near-black with deep blue tint
- **Fonts** Syne (display, all-caps, letter-spacing 2-3px) + DM Sans (UI body) + monospace (data values)
- **Borders** 1px solid, opacity 0.3-0.7, with corner brackets via `linear-gradient` `*-no-repeat` tricks
- **Chamfered corners** via `clip-path: polygon(...)` — never round corners on chrome
- **Scanlines** `repeating-linear-gradient` at 0.08-0.24 opacity
- **Glow** layered via `box-shadow: 0 0 Npx rgba(0,212,255,0.2)` + a subtle `filter: brightness(1.06)` on the main canvas

When adding new UI, match these — never invent a new color or radius.

---

## Known limitations

- **No collision** between panels — they pass through each other when thrown
- **Camera orbit fights drag at long press start** — handled by suspending orbit-follow when `pressTimer` is active, but can still feel twitchy during the press window
- **Gyro requires permission** on iOS 13+ — not auto-requested; add a button if mobile becomes a target
- **Spawned nodes are camera-facing** at spawn but become world-aligned once dragged (lookAt is one-shot) — could be made always-billboard if desired
- **Radial menu position** doesn't avoid screen edges — open near a corner and items clip

---

## File map

```
3d-environment.html
├── <head>
│   ├── importmap → three@0.183.2
│   └── <style> ── all CSS (incl. haptic cursor, radial, spawned-node colors)
├── <body>
│   ├── #three-canvas       — main 3D scene
│   ├── .hud × 4            — corner HUD panels
│   ├── #depth-bar          — bottom-center depth indicator
│   ├── #panel-detail       — right-side inspect card
│   ├── #avatar-zone        — Canvas2D avatar at bottom
│   ├── #spatial-chip       — top-center node/link counter   ← haptic
│   ├── #spatial-actions    — bottom-right + node / reset    ← haptic
│   ├── #radial             — 5-spoke long-press menu        ← haptic
│   ├── #spatial-toast      — top-center sci-fi toast        ← haptic
│   └── #handheld           — draggable terminal (chat/config/syslog)
└── <script type="module">
    ├── Three.js scene setup (camera, renderer, fog, grid)
    ├── Stars, nebulae, wireframes, blueprint panels
    ├── Avatar 2D (separate canvas)
    ├── Raycaster + hover
    ├── HAPTIC SPATIAL LAYER ─── grab/throw/spawn/radial/links
    ├── Touch + gyro
    ├── Render loop (panel float + throw decay + link rebuild)
    └── Terminal logic (tabs, drag, chat, syslog)
```

---

## Quick reference for new contributors

```bash
# To add a feature
1. Read this file end-to-end
2. Match the visual contract — no new colors, no rounded corners on chrome
3. If the feature is a panel, use `spawnNode()` + a custom data object
4. If it's a global UI, copy the corner-bracket pattern from `.hud` or `#handheld`
5. Add a keybind hint to #depth-hint if it's a top-level interaction
6. Update this file
```
