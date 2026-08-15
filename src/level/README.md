# Arena level

A self-contained level subsystem that builds **one small blue-hour cargo-bay
arena** for the vertical slice (issue #32). It supplies three things and nothing
else: the rendered geometry, the procedural materials, and the `StaticWorld`
(`StaticBox[]`) the player motor collides against.

It is mounted by the boot path after `RenderSystem`, exactly like the merged
HUD/audio/FX subsystems; it never self-registers.

```ts
import { ArenaLevel } from './level/index.js';
engine.add(render);
engine.add(new ArenaLevel()); // after render, so the sky IBL is already live
```

## The one rule this subsystem is built around

**Rendered geometry and collision are the same data.** #8 (the prior level) was
blocked because it authored collision *by hand, separately* from the meshes, so
the two drifted: a pipe-bank collider with no visible geometry, and quay rails
offset from what the player actually hit.

Here, every solid is a single `Solid` record — an axis-aligned box with a
material and a `collide` flag (`arena.ts`). Both outputs are **derived** from it:

- `geometry.ts` merges the solids by material into the meshes the GPU draws.
- `staticWorld.ts` turns the collidable solids into `StaticBox[]` and runs the
  core contract's own `assertValidStaticWorld`.

They cannot disagree by construction — and `correspondence.ts` **proves** it
rather than asserting it (see below). Axis-aligned boxes are the whole world on
purpose: the motor is verified on flat floors, steps and walls but not slopes,
so a box world keeps the unverified solver unreachable (#32).

## Correspondence proof

`checkCorrespondence()` reads the **real merged `three` buffers** and the **real
`StaticWorld`** and runs **five checks**:

| check | what it catches |
|-------|-----------------|
| `core-contract` | a malformed/degenerate/out-of-bounds world (`assertValidStaticWorld`) |
| `box-count` + `bijection` | a collider with no solid, or a solid with no collider; a box whose bounds or surface drifted |
| `render-backing` | a collider with **no rendered vertex at its corners** — the #8 invisible-collider and offset-rail bugs |
| `render-membership` | a collidable solid dropped from the rendered scene |

`render-backing` is the important one: for every collision box it confirms the
actual merged geometry has a vertex at all eight corners (quantised to 1 mm). An
offset box fails it; an invisible collider fails it.

The proof runs in two places:

1. **At boot** — `ArenaLevel.init` runs it against the buffers it just built and
   **throws** if it fails. The running game refuses to present cover the player
   cannot trust. This is the guard #8 lacked.
2. **In CI / on demand** — `verify-correspondence.mjs` loads the harness, lets
   the runtime build the real buffers, and reads back
   `window.__ARENA_CHECK__`. It does not re-derive the answer (that would only
   prove the script agrees with itself); it reports the runtime's proof and
   exits non-zero on any failure.

```sh
# start the dev server (repo root), then:
node src/level/verify-correspondence.mjs \
  --url http://127.0.0.1:5283/src/level/harness.html
```

## Materials & lighting

All textures are **procedural / CC0** — generated at runtime from canvas + value
noise in `materials.ts`. No image asset, no HDRI, no third-party or trademarked
content. The metals and concrete are `MeshStandardMaterial`s so the render
pipeline's procedural-sky IBL lights them; the container palette is carried by
vertex colours so the whole weathered set is one merged draw call.

Lighting is blue-hour: a warm directional key **aligned to the render pipeline's
IBL sun direction** `(-8, 14, 6)` (so highlights agree with the shadow it casts),
a cool hemisphere fill, and warm sodium practicals with a single cold accent at
the objective — the cool/warm split shipped shooters use. `N8AO` is **not** used
(it is ~8 ms on this machine and alone breaks the 16.7 ms budget, #1/#12).

## Contact-grounding shadows (#60)

Because `N8AO` is off, nothing darkens the floor where cover meets it: a direct
on/off framebuffer diff of the shipped VSM/IBL pass moved only **0.77 % of pixels
at mean 0.154/255** under the props — visually negligible — so the crates and the
jersey barrier read as hovering a millimetre above the slab. `contactShadows.ts`
authors the missing cue directly instead of paying for a full AO pass: one flat,
soft dark mark on the floor under each **floor-standing** piece of cover, sized to
that solid's exact footprint.

**Same-data rule, again.** The marks are derived from the same `Solid` min/max
records as the geometry and the collider — footprint centre `(min+max)/2`, size
`(max−min)` on X/Z — so a mark can never drift from the object it grounds (no
duplicated coordinates). Selection is explicit and auditable
(`classifyGroundContact`): a solid earns a mark **iff** it is collidable cover
(drops the render-only lamps, beacon and floor paint), rests on the floor top
`y=0` (drops the floor slab, every stacked upper solid, and the elevated
deck/parapets), and is not architecture (an authored `wall`/`step`/`deck`/`parapet`
id family drops the perimeter walls and the *walkable* stairs). In the shipped
arena that selects exactly **10** solids: `cont-a, cont-c, jersey-w1, jersey-w2,
crate-w1, crate-w2, dock-obj, jersey-n1, pallet-n, drum-n1`.

**Render-only, by construction.** The layer is a single `InstancedMesh` added to
the render group but **never** to the collider and never to the merged solids
`correspondence.ts` scans, so it cannot enter collision or make the 5/5 proof
misclassify a mark as geometry (the fixture asserts the mark corner-keys never
intersect any collider corner-key). The quad is baked flat into the XZ plane — it
is geometrically horizontal and cannot climb a vertical face — lifted a measured
**6 mm** with a polygon-offset depth bias, `depthWrite:false` so it occludes
nothing and `depthTest:true` so cover standing in front hides it.

**Budget: +1 draw, 0 textures.** One `InstancedMesh` is one draw call regardless
of instance count, and the soft rounded-rectangle penumbra is computed
analytically in the fragment shader from a per-instance footprint — **no generated
texture at all**, and footprint-aware (a long container gets a long mark, a drum a
small square-ish one, with a uniform 0.20 m soft edge — never an oval sticker).
Nothing is allocated per frame. Matched 1920×1080 on/off captures on this session's
arena harness measured the delta at exactly **+1 draw call (27 vs 26), +0 textures
(23 vs 23)**, +20 triangles (the 10 quads).

It composes automatically: `ArenaLevel.init` builds the layer after correspondence
passes and adds it to the render root; `?contact=0` on any harness or production
URL disables it for a matched off-frame. Lifecycle is repeatable — `dispose()`
removes the mesh and disposes the mesh, the one shared geometry and the one
material.

`fixtures/contact-shadows.harness.mjs` proves all of the above headlessly against
the shipped modules — selection/count, exact-footprint correspondence,
horizontality + y-offset, the render-only/no-collider guarantee, correspondence
still 5/5, a **negative control** (the floor, a perimeter wall, a stair tread, a
stacked crate and the beacon are all rejected), repeatable lifecycle, the
+1-draw/0-texture budget, and an on/off pixel diff. Run it against the dev server:

```sh
node src/level/fixtures/run-contact-shadows.mjs \
  --url http://127.0.0.1:5283/src/level/fixtures/contact-shadows.harness.html
```

- **13/13 PASS**, 10 marks, **+1 draw / +0 texture**. The on/off pixel diff moves
  **1.15 % of pixels at mean 16.9/255 where changed** — against the VSM baseline's
  0.77 % / 0.154 the authored mark lands local and ~110× stronger where it matters,
  which is the whole point. Report: `evidence/contact-shadows.report.json`.
- Matched captures: `evidence/contact-on/{grounding,lane_west,materials}.png` vs
  `evidence/contact-off/…` — the jersey barrier and the crate bases stop floating,
  with no climbing of vertical faces, no edge-bridging and no z-fighting.

## Layout

~24 m × 21 m, tuned for 1 player vs 1 enemy:

- A **staggered container stack** mid-arena breaks the straight spawn→objective
  sightline and forces a left/right choice.
- A **west lane** with chest-high concrete (crouch-and-peek) and a broken crate
  stack.
- An **east overwatch deck** reached by real **steps** (the motor is verified on
  steps, so verticality is a stair of boxes, not a ramp): six ascending
  0.267 m treads (each rise < the shipping motor's 0.34 m step limit), the top
  tread flush with the deck, climbing through a **doorway gap in the south
  parapet** so the climb actually lands on the deck. The parapet is cover but is
  itself exposed from the north, so holding the deck is a trade, not a free
  perch. That a *player* — not a free camera — can walk floor→deck up these exact
  boxes is proven by the traversal fixture (see below), not asserted.
- An **objective end** with a cool beacon that draws the eye and gives bloom a
  second, colder source.

`buildArena()` also exports `playerSpawn`, `enemySpawn` and the camera `shots`
used for evidence; the built `StaticWorld` and spawns are published on
`window.__LEVEL_STATIC_WORLD__` / `window.__ARENA_SPAWNS__` for a future
player/AI motor.

## Evidence harness

`harness.html` / `harness.ts` boot the real engine + render pipeline with the
arena mounted after it — the same order and presentation seam as `src/main.ts`,
so captures are the arena *under the shipped pipeline*. Serve it from the repo
dev server and drive `tools/shoot.mjs` at it:

```sh
npm exec --prefix <repo> -- vite <repo> --host 127.0.0.1 --port 5283 --strictPort
node tools/shoot.mjs \
  --url http://127.0.0.1:5283/src/level/harness.html \
  --out shots/arena \
  --shots default,spawn,lane_west,overwatch,stairs,objective,silhouette,materials
```

The arena owns `window.__SHOT__`; shot names and captions are in
`window.__SHOT_LIST__`.

## Traversal proof — a player can actually reach the deck

Correspondence proves the rendered geometry and the collision boxes *agree*.
It says nothing about whether a **human** can climb what they agree on: the
first version of this deck (PR #38) had an inverted staircase and a solid south
parapet, so render and collision agreed on geometry a player could not reach
(issue #43). `fixtures/deck-traversal.harness.mjs` closes that gap with the only
witness that counts — the **shipping `PlayerMotor` + `StaticBoxWorld`** (the
player subsystem, PR #40, tuning pinned at `DEFAULT_PLAYER_TUNING`) driven
against the arena's **real `StaticWorld`** (`buildStaticWorld(buildArena())`).

It spawns a capsule **on the floor** south of the stairs and drives ordinary
"forward" (north) WASD intent at the engine's 120 Hz fixed step — **no
teleport, no `motor.position =`, no free camera** — until the feet finish
standing on the deck. Every target (deck height, stair centre, spawn) is derived
from the arena geometry, so the fixture cannot drift from a layout change. Five
assertions gate it: started on the floor, stayed grounded through the climb
(0 airborne ticks), each step-up ≤ `maxStepHeight`, reached the deck, finished
standing on the deck footprint past the parapet.

```sh
node src/level/fixtures/run-deck-traversal.mjs \
  --url http://127.0.0.1:5283/src/level/fixtures/deck-traversal.harness.html
```

- Fixed geometry: **5/5 PASS**, feet finish at y=1.60 m, x=7.40, z=−11.12
  (deck interior, past the parapet), max step-up **0.267 m ≤ 0.34 m**, 0 airborne
  ticks. Report: `evidence/deck-traversal.report.json`.
- **Negative control** (the pre-fix geometry, run by temporarily reverting the
  stairs): the same motor is **blocked at the base of the 1.60 m first tread**,
  never reaches the deck — 2 assertions FAIL. Report:
  `evidence/deck-traversal.baseline-defect.report.json`. This is what makes the
  fixture a real test rather than a tautology: it fails on the defect it guards
  against.

> Running the fixture requires the player subsystem (`src/player/`, PR #40) to be
> present in the tree — the harness imports the real motor from it. The committed
> level subsystem does not vendor or edit `src/player/`; the import is the
> "narrowly scoped test import" carve-out.

### Measured (ANGLE Metal / Apple M4, 1920×1080, 16.7 ms budget)

Committed captures are in `src/level/evidence/`. GPU timing on this machine's
dynamic clocks varies between runs, so three independent trials were taken and
the **worst** p95 is reported. Raw reports: `evidence/timing-trial-{1,2,3}.json`.

| trial | budget p95 (max CPU/GPU) | GPU median | worst single frame | disjoint |
|-------|--------------------------|------------|--------------------|----------|
| 1 | 13.958 ms | 9.718 ms | 17.526 ms | 0 |
| 2 | **14.410 ms** | 10.203 ms | 17.659 ms | 0 |
| 3 | 14.328 ms | 10.114 ms | 16.624 ms | 0 |

Worst-of-three p95 **14.410 ms ≤ 16.7 ms** (the harness reports `overBudget:false`
on all three, 0 console errors). **38 draw calls, 870 triangles**, 15 programs,
35 textures. Note the honest limitation: p95 clears budget, but occasional
single frames spike to ~17–18 ms; on this shared machine those are within
run-to-run variance rather than a steady overrun. See PR body for the full
report.

Visual claims map to captures: `spawn.png` (left/right sightline break),
`lane_west.png` (crouch-and-peek cover), `overwatch.png` (standing eye height on
the now-reachable deck, over the parapet onto the beacon), `stairs.png` (the
corrected ascending stair climbing through the parapet doorway — the geometry
issue #43 blocked), `objective.png` (backlit container silhouette, ascending
stair visible at left), `silhouette.png` (whole-arena read), `materials.png`
(weathered-container IBL response). All seven are regenerated by the `shoot.mjs`
command above.

## Scope / not shipped here

This directory is the level *library*. Mounting it in production (replacing
`TestLevel` in `src/main.ts`) is the integration coordinator's call — this
subsystem does not edit `src/main.ts` or any core/render file. There is no enemy
AI or player controller here; the arena exposes the spawns and `StaticWorld`
they will consume.
