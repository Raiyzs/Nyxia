# Do After 3D Space Environment

Base file: `~/Downloads/3d-environment.html`  
Stack: Three.js 0.160, plain HTML, WebXR-ready renderer

---

## 1. Webcam Hand Tracking (Desktop)

**Library:** MediaPipe Hands (`@mediapipe/hands` + `@mediapipe/camera_utils`)  
CDN drop-in, no backend needed.

**Map landmarks to scene:**
- Index finger tip (landmark 8) → panel hover / raycaster substitute
- Pinch (thumb tip + index tip distance < threshold) → click / openDetail()
- Two-hand spread → zoom (orbit.tR)
- Wrist Y delta → orbit.tEl
- Wrist X delta → orbit.tAz

**Implementation note:** Run MediaPipe alongside the existing render loop.
Feed normalized x/y from landmark 8 into `doRaycast()` instead of mouse coords.

---

## 2. Quest 2 WebXR (Immersive VR)

**Built into Three.js** — minimal changes needed.

Steps:
1. Import `VRButton` from `three/examples/jsm/webxr/VRButton.js`
2. Set `renderer.xr.enabled = true`
3. Append `VRButton.createButton(renderer)` to DOM
4. Replace `requestAnimationFrame` loop with `renderer.setAnimationLoop(animate)`
5. Add `XRControllerModelFactory` for controller visuals

**Hand tracking (controller-free):**
- Enable `hand-tracking` feature in XR session
- Use `renderer.xr.getHand(0/1)` → `XRHand` joints
- Map `index-finger-tip` joint → raycaster for panel interaction
- Quest 2 browser natively supports this without controllers

**AR passthrough:**
- Change session type to `immersive-ar`  
- Requires Meta Browser on Quest 2 with passthrough enabled
- Overlay the 3D scene on real room

---

## 3. Input Redundancy — Webcam as Quest 2 Failover

**Goal:** Quest 2 XRHand glitches/drops → webcam MediaPipe takes over seamlessly.
Quest 2 hand tracking known failure modes: low light, fast motion, hands occluded,
near edge of camera FOV, hands too close together.

**Strategy: confidence-weighted input fusion**

Both sources run simultaneously. Each frame, pick the higher-confidence source:

```
Quest 2 XRHand  →  confidence score (joint radius / tracking state)
                          ↓
                    Fusion layer         → scene input
                          ↑
Webcam MediaPipe →  confidence score (landmark visibility 0-1)
```

Switching logic (inside Quest 2 browser, webcam via `getUserMedia`):
- XRHand joint `XRJointSpace` has a `radius` — if joints go missing → score drops
- MediaPipe landmark `.visibility` < 0.6 → deprioritize
- Blend: `input = xrScore > mpScore ? xrData : mpData`
- Add ~100ms hysteresis before switching to avoid flicker

**Latency profile:**
- Quest 2 XRHand: ~30-60ms, drops to nothing on glitch
- MediaPipe webcam: ~40-80ms, very stable, degrades gracefully
- Fused: worst case you feel a single frame stutter instead of full drop

**Implementation:** Both run in the same Quest 2 browser tab.
`getUserMedia` works in Quest 2's Meta Browser — webcam = front passthrough cameras.
No separate device, no WebSocket needed.

---

## 4. HTC Vive 2 / Vive Sensors — Verdict

**For this web-based Three.js setup: not useful.**

- Vive uses Lighthouse base stations (external IR tracking)
- Quest 2 uses inside-out tracking (built-in cameras)
- These systems don't interoperate at the WebXR layer
- WebXR only exposes the headset's own tracking — Lighthouse data never reaches the browser

**Where Vive sensors WOULD add value:**
- SteamVR desktop app (not web)
- If using **Vive Trackers** (body/feet/hands) via SteamVR + Virtual Desktop
  → Quest 2 as display, PC rendering in SteamVR, Vive Trackers for body IK
  → Full-body avatar tracking in Nyxia scene
  → But this is a completely different architecture (native app, not HTML)

**Conclusion:** Skip Vive sensors for the web version.
Revisit if the project ever moves to a native SteamVR/Unity build.

---

## Implementation Order

1. WebXR VRButton → Quest 2 immersive-vr (1-2h, mostly boilerplate)
2. XRHand panel interaction on Quest 2 (2-4h)
3. MediaPipe Hands on desktop (2-3h)
4. WebSocket sync bridge if co-presence needed (4-6h)
5. AR passthrough mode (1h once VR works)
