# `coop/render` — horizontal split-screen rendering

A self-contained library for drawing **one shared scene through two independent
cameras** into a horizontal (stacked) split screen, plus the exact
viewport/scissor math that makes the two views tile the drawing buffer with **no
seam gap and no overlap** — including odd buffer sizes and fractional device
pixel ratios.

It is deliberately small and passive. It plans rectangles and issues
presentation calls; it does **not** read input, step simulation, own a render
loop, or touch any shared engine file. `main.ts`, `RenderSystem`, and the engine
core are untouched — this library is meant to be *composed* by a thin
integration layer, not to be that layer. See [Integration seam](#integration-seam).

```
src/coop/render/
  viewport.ts      pure viewport/scissor math (no THREE, no DOM, no renderer)
  coordinator.ts   CoopRenderCoordinator — draws the split, restores all state
  index.ts         public barrel
  evidence/        browser-free deterministic proof (11 sections + controls)
  harness/         real-WebGL harness (slot isolation, seam, GPU perf trials)
```

## The math (why a pixel never goes missing)

Two coordinate systems are kept strictly distinct:

- **CSS / logical pixels** — what layout and `window.innerWidth/Height` speak,
  and what `THREE.WebGLRenderer.setViewport/setScissor` accept. THREE multiplies
  these by the pixel ratio internally.
- **Backing / drawing-buffer pixels** — the real framebuffer the GPU rasterises
  into: `floor(css * pixelRatio)` per axis, exactly how `renderer.setSize` sizes
  the canvas in three r185. WebGL `viewport`/`scissor` are **integers** here with
  the origin at the **bottom-left**.

The **backing rectangles are the source of truth**, because only integers can
tile a buffer with no gap and no overlap. The CSS rectangles handed to THREE are
derived as `backing / pixelRatio`, so that when THREE re-applies
`round(css * pixelRatio)` (its r185 conversion for `setViewport`/`setScissor`)
it lands back on the **exact** integer backing rectangle:

```
round(B / pr * pr) === B      for integer B
```

This round-trip is robust to floating-point error because the value sits a whole
unit away from any half-integer. `checkExactTiling` asserts precisely this
round-trip, plus full-width coverage, integer extents, band adjacency, and full
height coverage. A naive CSS-space split (e.g. "each half is `height/2` CSS px")
fails this oracle on an odd buffer — that is the bug this module exists to
prevent.

### Orientation and the odd row

**"Horizontal split" means the divider is horizontal**: the players are stacked
one above the other, each spanning the full backing width and about half the
backing height. (A vertical divider — side-by-side halves — is a *different*
layout this module does not implement.)

- **Player 1 → TOP** slot (larger `y` in bottom-left GL coordinates).
- **Player 2 → BOTTOM** slot.

The shared edge is a single value `splitY`: the bottom band is `[0, splitY)` and
the top band is `[splitY, backingHeight)`. Because both bands are defined from
that one value, they can never disagree by a pixel.

When the backing height is **odd** the two integer halves cannot be equal. The
extra row goes to the slot named by `oddRowSlot` (**default `'top'`**), so the
union still tiles `[0, backingHeight)` exactly. This is a deterministic,
documented choice — not an artifact of rounding. Example: backing height `361`
⇒ `splitY = 180`, bottom `= [0,180)` (180 px), top `= [180,361)` (181 px).

### Refusals (never a silent no-op)

`planCoopViewports` is **total**: every invalid or degenerate input returns a
`{ renderable: false, reason }` value instead of throwing or producing a `NaN`
aspect. It refuses non-finite/≤0 logical sizes, non-finite/≤0 pixel ratios, a
drawing buffer that floors to `< 1` px on either axis, and a 2-player buffer
whose backing height is `< 2` px (cannot host two bands). The coordinator treats
a refusal as inert: it touches **no** GL or camera state and returns the reason.

## API

```ts
import {
  planCoopViewports,
  checkExactTiling,
  CoopRenderCoordinator,
} from './coop/render/index.js';

// 1) Plan — pure, cheap, call it on resize.
const plan = planCoopViewports({
  cssWidth: renderer.getSize(new THREE.Vector2()).x,
  cssHeight: renderer.getSize(new THREE.Vector2()).y,
  pixelRatio: renderer.getPixelRatio(),
  players: 2,            // 1 = full screen, 2 = horizontal split
  // oddRowSlot: 'top',  // optional; which slot gets the extra odd row
});

// 2) Render — one shared scene, two cameras, full state restoration.
const coordinator = new CoopRenderCoordinator();   // reusable; no per-frame alloc
const result = coordinator.renderCoop(plan, scene, [p1Camera, p2Camera], renderer);
// result: { rendered: true, slots: 2 } | { rendered: false, reason }
```

- `planCoopViewports(input) → RenderableCoopPlan | RefusedCoopPlan` — the
  discriminated union above; `RenderableCoopPlan` carries `backing`, `css`,
  `pixelRatio`, and player-ordered `slots` (each with `backing`, `css`, and the
  slot's true `aspect = backing.width / backing.height`).
- `checkExactTiling(plan) → { exact, reason? }` — the seam-gap/overlap oracle;
  used by the fixtures and the harness, available to callers as an assertion.
- `CoopRenderCoordinator.renderCoop(plan, scene, cameras, renderer, options?)` —
  see below. `options` allows per-slot clear colours (`slotClearColors`,
  presentation only), `slotClearAlpha`, and `clearDepth`.

The renderer is accepted through the structural `CoopRendererLike` interface —
exactly the surface `THREE.WebGLRenderer` already exposes — so the same
coordinator drives the real renderer and the fixtures' call-recording fake.

### What the coordinator guarantees

- **Per slot, presentation only:** set camera `aspect` + `updateProjectionMatrix`,
  `setViewport(css)`, `setScissor(css)`, optional per-slot `setClearColor`,
  scissored `clear`, and one `render(scene, camera)`. The scissor test confines
  each slot's clear and draw to its own band, so slot 1's clear cannot erase
  slot 0's pixels.
- **No duplicated simulation:** there is no update/step/input hook anywhere — the
  *same* `scene` reference is drawn through each camera on world matrices already
  computed once for the frame. "No second update path" is a property of the type,
  not a promise.
- **Full state restoration (mirrors `RenderSystem.render`):** viewport, scissor,
  scissor-test, `autoClear`, clear colour/alpha, and each camera's `aspect` +
  `projectionMatrix` + `projectionMatrixInverse` are saved up front and restored
  in a `finally`. Cameras are restored **before** the renderer, so no later
  observer ever sees a slot-aspect camera under a slot viewport. A draw that
  throws propagates **after** restoration completes.

## Integration seam

This library never edits `main.ts` or `RenderSystem`. A thin integration layer
(a separate future change, outside this directory) wires it in without touching
shared files, for example as an alternative present step:

```ts
// pseudocode for an integration layer that OWNS the wiring:
const coordinator = new CoopRenderCoordinator();

function presentCoop(renderer, scene, p1, p2) {
  const size = renderer.getSize(new THREE.Vector2());
  const plan = planCoopViewports({
    cssWidth: size.x, cssHeight: size.y,
    pixelRatio: renderer.getPixelRatio(),
    players: 2,
  });
  if (!plan.renderable) return;         // zero-size / minimised: skip cleanly
  coordinator.renderCoop(plan, scene, [p1, p2], renderer);
}
```

Because `renderCoop` saves and restores everything it touches, this can run in
place of a single-camera present without leaking split-screen state back into
the normal path. Resize needs no special handling beyond re-planning from the
current size — the plan is recomputed each frame (or on resize) and is cheap.

The one thing this library intentionally does **not** provide is the second
camera's *simulation* (a second player's transform/controller) and the decision
of *where* the co-op present step is invoked from. That belongs to the
integration layer and to the broader issue #71 co-op work; keeping it out is what
lets this library stay free of a duplicated update path.

## Evidence

### Browser-free deterministic proof — `evidence/`

Pure Node (no DOM, no WebGL). Compiles the fixtures with a dedicated tsconfig
into the gitignored `dist/coop-render`, imports them, and asserts 11 sections
including negative controls:

```
node src/coop/render/evidence/run.mjs
```

Result (checked in at `evidence/report.json`): **11/11 pass** —
`singlePlayerFullscreen`, `horizontalSplitTiling`, `seamNegativeControl`,
`zeroSizeRefusal`, `resizeDeterminism`, `coordinatorSplit`,
`coordinatorRestoresOnThrow`, `isolationOracleControl`,
`singlePlayerCoordinator`, `coordinatorDeterminism`, `refusalIsInert`. The
negative controls confirm the oracle is not trivially green: a hand-broken
CSS-space split is caught as a seam defect, an overlapping slot pair is rejected
by the isolation oracle, refusals leave the fake renderer untouched, and a
throwing draw still restores every saved value.

### Real-WebGL harness — `harness/`

Starts a throwaway Vite dev server rooted at the repo (so bare `three` and the
`.js`-specifier-to-`.ts` imports resolve exactly as in the app) and drives a real
`THREE.WebGLRenderer` in GPU-backed headless Chromium (ANGLE/Metal):

```
node src/coop/render/harness/run.mjs      # writes harness/report.json, exits non-zero on failure
```

It reads pixels **back off the GPU** to prove, on real hardware:

- **slotIsolation** — a shared scene (red slab at `x=-50`, blue slab at `x=+50`)
  drawn through P1 at `(-2,0,0)` looking `-x` and P2 at `(2,0,0)` looking `+x`:
  the **top** slot centre reads red, the **bottom** reads blue, and they differ.
  Each slot is first cleared to a **saturated green sentinel**, so a red reading
  can only come from rendered geometry, never from an unrendered slot. Pixels are
  classified with a **threshold + margin** rule (a channel must clear
  `MIN_LEVEL=96` and beat the others by `MARGIN=64`, else `none`), not a bare
  argmax. A negative control renders both slots through the *same* camera and
  confirms the read-back would have caught sameness (both slots then read red).
- **emptySlotRejection** — the oracle-hardening control a cold review asked for.
  A bare `argmax` classifies black `[0,0,0]` as `r`, so an *unrendered* (black)
  slot could have satisfied `topChan === 'r'`. This control renders an **empty**
  scene into both slots over a black clear: the hardened classifier reports
  `none` for both (so the isolation predicate is **rejected**), while the report
  records that the old argmax **would** have misread black as red — proving the
  control bites and the gap is closed.
- **seamTiling** — over an **odd** backing buffer (`641×361`, `splitY=180`) the
  whole buffer is first painted a sentinel green, then each slot is cleared to a
  known colour. The centre column transitions blue→red at exactly `splitY` with
  **zero** green rows surviving. Hand-broken **gap** (bottom one row short) and
  **overlap** (bottom one row tall) plans are both detected.
- **gpuTrials** — three trials of the two-view render at **half** device pixel
  ratio, each timed with `EXT_disjoint_timer_query_webgl2` exactly as the
  engine's `FrameProfiler` does (drain on `QUERY_RESULT_AVAILABLE`, honour
  `GPU_DISJOINT`).

#### Measured result (Apple M4, ANGLE Metal Renderer, three r185, timer 64-bit)

Half-DPR backing **960×540**, two 960×270 views, 60 timed samples per trial,
budget **16.7 ms**:

| trial | samples | median (ms) | p95 (ms) | disjoint | ≤ budget |
|-------|---------|-------------|----------|----------|----------|
| 1     | 60      | 0.135       | 0.387    | false    | yes      |
| 2     | 60      | 0.132       | 0.147    | false    | yes      |
| 3     | 60      | 0.132       | 0.331    | false    | yes      |

All three trials measured cleanly (no disjoint) and all p95 values are far under
the 16.7 ms budget. (Timings vary run to run; the committed `harness/report.json`
holds the exact numbers from the latest run.)

**Scope of the perf claim.** The numbers above are for the harness's **minimal
two-slab scene**, and they measure only the *two-view present cost* of this
library (viewport/scissor/clear/aspect + two `render` calls) at half resolution.
They are **not** a claim that a full game scene fits the budget: that depends on
the scene the integration layer feeds in, which is out of this library's scope.
If the GPU timer is ever unsupported or reports disjoint, the harness marks the
trials **`UNVERIFIED`** and never fabricates a number — matching the honest
refusal philosophy of `core/profiler.ts`.

## Non-goals / gaps

- No second-player simulation, input, or controller — presentation only.
- No decision about *where* the co-op present is invoked; that is the
  integration layer's job (kept out on purpose to avoid a duplicated update path).
- Vertical (side-by-side) split and >2 players are not implemented.
- The perf trials characterise this library's two-view overhead on a minimal
  scene, not an end-to-end frame budget for the real game.
