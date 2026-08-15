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

## Layout

~24 m × 21 m, tuned for 1 player vs 1 enemy:

- A **staggered container stack** mid-arena breaks the straight spawn→objective
  sightline and forces a left/right choice.
- A **west lane** with chest-high concrete (crouch-and-peek) and a broken crate
  stack.
- An **east overwatch deck** reached by real **steps** (the motor is verified on
  steps, so verticality is a stair of boxes, not a ramp), with a parapet for
  cover — itself exposed from the north, so holding it is a trade, not a free
  perch.
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
  --shots default,spawn,lane_west,overwatch,objective,silhouette,materials
```

The arena owns `window.__SHOT__`; shot names and captions are in
`window.__SHOT_LIST__`.

### Measured (ANGLE Metal / Apple M4, 1920×1080, 16.7 ms budget)

Committed captures are in `src/level/evidence/`. GPU timing on this machine's
dynamic clocks varies between runs, so three independent trials were taken and
the **worst** p95 is reported. Raw reports: `evidence/timing-trial-{1,2,3}.json`.

| trial | budget p95 (max CPU/GPU) | GPU median | worst single frame | disjoint |
|-------|--------------------------|------------|--------------------|----------|
| 1 | 14.545 ms | 11.712 ms | 18.421 ms | 0 |
| 2 | **15.332 ms** | 11.986 ms | 18.121 ms | 0 |
| 3 | 14.922 ms | 11.813 ms | 19.663 ms | 0 |

Worst-of-three p95 **15.332 ms ≤ 16.7 ms** (the harness reports `overBudget:false`
on all three, 0 console errors). **38 draw calls, 822 triangles**, 15 programs,
35 textures. Note the honest limitation: p95 clears budget, but occasional
single frames spike to ~18–19 ms; on this shared machine those are within
run-to-run variance rather than a steady overrun. See PR body for the full
report.

Visual claims map to captures: `spawn.png` (left/right sightline break),
`lane_west.png` (crouch-and-peek cover), `overwatch.png` (elevated height read
over the parapet onto the beacon), `objective.png` (backlit container silhouette),
`silhouette.png` (whole-arena read), `materials.png` (weathered-container IBL
response). All six are regenerated by the `shoot.mjs` command above.

## Scope / not shipped here

This directory is the level *library*. Mounting it in production (replacing
`TestLevel` in `src/main.ts`) is the integration coordinator's call — this
subsystem does not edit `src/main.ts` or any core/render file. There is no enemy
AI or player controller here; the arena exposes the spawns and `StaticWorld`
they will consume.
