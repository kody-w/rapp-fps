# Mission 3 — "Foundry Last Light"

A pure, original, **AABB-only** arena for the shipped level pipeline: a warm
furnace hall against a cool blue-hour ambient, a casting lane of crouch-and-peek
cover, heavy machine plinths, and a **stair-accessed control gantry** holding the
defended **final shutdown objective** — the "last light" to switch off.

This mission is authored entirely under `src/level/missions/foundry/**`. It edits
**no shared file and no `main`** — it composes the existing, untouched level
subsystem (`ArenaLevel`, `staticWorld`, `geometry`/`mergeSolidsByMaterial`,
`correspondence`, `materials`, `RenderSystem`, and the shipping `PlayerMotor` +
`StaticBoxWorld`) around a new, contract-compatible definition. The parent
integrates later by calling `createFoundryLevel()` (see **Integration** below).

Issue #73. Refs #70.

---

## Design intent

- **Furnace contrast.** A heavy iron hearth, chimney stack and buttress anchor
  the north-east and light it with clustered warm point lights (0xff7420 /
  0xff8a2c) and an emissive tap-stream and hood. The rest of the hall is a cool
  hemisphere (0x6f8ec2) with a cyan "last light" beacon (0x4fd6ea) on the far
  objective — the warm/cool read the brief asks for, carried entirely by the
  per-mission `LightSpec` (the shared IBL sun stays at its fixed `(-8,14,6)`, so
  the mission's directional key matches it and cast shadows agree with highlights).
- **Casting lane.** Ingot moulds, a ladle car and a slag pot down a central
  spine, flanked by heavy press plinths (one carrying a stacked ram head for a
  broken silhouette). A reserved west-of-centre corridor threads them so a walker
  has a clean line up the lane while the machinery walls the objective's sightline.
- **Control gantry + finale.** A galvanised deck in the north-west, reached by a
  six-tread stair climbing **west** onto the deck through a parapet doorway. The
  objective is a waist-high control console on the deck; a defender holds it from
  behind the console and the south parapet.

### Structural distinctness from the cargo bay

This is a **finale, not a Cargo reskin**. It is provably distinct on every axis
the topology fingerprint checks (`fingerprint.ts`, asserted in the analysis
harness against the real `buildArena()`):

| field | Foundry | Cargo |
| --- | --- | --- |
| bounds (min\|max) | `-14.1,-1.1,-18.1 \| 14.1,6.1,6.1` | `-13.1,-1.1,-21.1 \| 13.1,6.5,2.1` |
| solid count | 43 | 36 |
| collidable count | 36 | 29 |
| id hash (FNV-1a) | `b572fefe` | `7645a4b3` |
| spawn key (player→enemy) | `-4,0,3.2 > 1,0,-9.5` | `0,0,-1.6 > -9,0,-13` |
| route (vertical signature) | `top5.6\|elev7\|h22` | `top6\|elev7\|h19` |
| initial sightline | `n0\|firstclear` | `n2\|firstcrate-w2` |

The mission is **wider and shallower** than Cargo (26×22 vs 24×21), its stair
climbs **west** (Cargo climbs north), it uses **none** of the `container`
material (so the shared `selectContainerSolids` dressing is inert), and the
objective/route/sightline all differ. The Relay contract is **not** imported and
its branch is untouched.

---

## Hard gates → evidence

Everything below is **measured**, not asserted by hand: each harness runs the
**exact shipping modules** headlessly (Vite serves the real `.ts`; the `.mjs`
fixtures import the real `PlayerMotor`, `ArenaLevel`, etc.). Re-run with the
commands in **Reproduce**. Every gate currently **passes**.

| Gate | Evidence | Result |
| --- | --- | --- |
| One-source solids ⇄ render ⇄ collision, proven against **real GPU buffers** | `evidence/correspondence/report.json` | `ok`, 43 solids, 36 collidable = 36 boxes, 5/5 checks, `consoleErrors: []` |
| Core world validation (`assertValidStaticWorld`) | analysis + correspondence | pass |
| Two clear **feet-based** player spawns | `evidence/analysis.report.json › spawns` | `[-4,0,3.2]`, `[4,0,3.2]`, both feet-on-floor, capsule (r0.34/h1.78) fits, inside bounds, 8 m apart |
| Enemy spawn **clearance** (explicit gate) | `…› enemySpawn`, `foundry.ts` | `[1,0,-9.5]` measured with the shipping player capsule (r0.34/h1.78): `fits`, `insideBounds`, `feetOnFloor` all true |
| ≥4 cover ids | `foundry.ts › enemyCoverIds` | 5: `plinth-e2, ladle-car, furnace-buttress, console-obj, parapet-s` |
| Final objective metadata + location | `foundry.ts › finalObjective` | `console-obj` (`shutdown`) at `[-9,2.65,-12.8]`, deck `gantry-deck`, stand 1.7 |
| **Shipping-motor** deterministic route floor→lane→stairs→objective; each rise ≤0.34 m; zero airborne | `…› route.positive` | reached objective ✔, `maxStepUp 0.2833 m`, `airborneClimbTicks 0`, `minFeetY 0`, lands on deck y=1.7 |
| **Failing negative control** (non-vacuous) | `…› route.negativeControl` | remove `step-3` → doubled 0.567 m riser → climber **stalls at y=0.567**, never reaches gantry/objective |
| Objective acceptance derived from **authored `FinalObjective.footprint`** (non-vacuous) | `…› route.positive` | `arrivalRadius = hypot(1.6,1.0)+0.34 = 2.227 m`; arrival `hToObj 1.846 m` accepted, but **rejected** against a halved footprint (radius 1.283 m) → `footprintControlsAcceptance: true` |
| Spawn capsule clearance + bounds | `…› spawns` | measured per slot (fits/insideBounds/feetOnFloor) |
| Initial LOS policy | `…› los` | objective **occluded from both spawns** (slot0 by `plinth-w1`, slot1 by `parapet-s`) |
| Topology fingerprint distinct from Cargo (unique bounds/count/id/route/sightline) | `…› fingerprint` | `allDistinct: true` (table above) |
| Lifecycle init/update/dispose ×2 | `evidence/lifecycle.report.json` | correspondence OK both cycles, hooks installed **and cleared**, scene → baseline (0 children), no update throw |
| Empty-container path safe for `{ containerDressing: undefined }` (reproducing) | `…› undefinedDressingCycle` | `createFoundryLevel({ containerDressing: undefined })` coerces to `false`: `initThrew: false`, correspondence OK, scene → baseline. Pre-fix this threw `Cannot read properties of undefined (reading 'index')` |
| Visual frames @ 1920×1080 | `evidence/frames/*.png` | `furnace_contrast, casting_lane, gantry_traversal, final_objective, silhouette` |
| 3 hardware trials ≤16.7 ms, zero errors, explicit **port 5295** | `evidence/timing-trial-{1,2,3}/report.json` | p95 **6.73 / 6.66 / 6.71 ms**, `gpuDisjointCount 0`, `consoleErrors: []` |
| `tsc` clean | `npx tsc --noEmit` | exit 0 |

Rise arithmetic: `GANTRY_TOP 1.7 / STAIR_STEP_COUNT 6 = 0.28333 m < maxStepHeight 0.34 m`;
the top tread is flush with the deck (1.7 m), so the climb lands on the deck.

---

## Resource ceilings (honest, measured on Apple M4 / Metal via ANGLE, 1920×1080)

Measured per frame across the five shots (`evidence/frames/report.json`) and the
three timing trials. Ceilings are set **above** the measured figures with margin;
exceeding any of them should be treated as a regression to investigate.

| Resource | Measured | Ceiling |
| --- | --- | --- |
| Collidable boxes | 36 | **≤ 45** |
| Draw calls / frame | 25 | **≤ 32** |
| Triangles / frame | 1,056 | **≤ 2,000** |
| Textures | 22 | **≤ 28** |
| Geometries | 13 | **≤ 16** |
| Shader programs | 12 | **≤ 16** |
| Frame time p95 (max of CPU/GPU) | 5.6–6.7 ms | **≤ 16.7 ms** (60 fps) |

Geometry ships as **one merged mesh per material** (the shared
`mergeSolidsByMaterial`), which is what keeps the draw-call count low; there are
**zero external assets** — every surface is procedural material variation over
AABBs, and every light/emissive is authored data.

---

## Reproduce

Start the dev server on the **explicit port 5295** (the shared `vite.config.mjs`
pins 5273/`strictPort` and is not edited, so pass the port on the CLI):

```sh
npx vite --host 127.0.0.1 --port 5295 --strictPort
```

Then, from the repo root:

```sh
# Gate suite: world / spawns / LOS / stair / route (+ negative control) / fingerprint
node src/level/missions/foundry/fixtures/run-analysis.mjs \
  --url http://127.0.0.1:5295/src/level/missions/foundry/fixtures/analysis.html

# Render ⇄ collision correspondence against the real merged GPU buffers
node src/level/verify-correspondence.mjs \
  --url http://127.0.0.1:5295/src/level/missions/foundry/harness.html \
  --out src/level/missions/foundry/evidence/correspondence

# Lifecycle: init → update → dispose, twice
node src/level/missions/foundry/fixtures/run-lifecycle.mjs \
  --url http://127.0.0.1:5295/src/level/missions/foundry/fixtures/lifecycle.html

# Five visual frames + per-frame GPU stats, 1920×1080
node tools/shoot.mjs \
  --url http://127.0.0.1:5295/src/level/missions/foundry/harness.html \
  --out src/level/missions/foundry/evidence/frames \
  --shots furnace_contrast,casting_lane,gantry_traversal,final_objective,silhouette

# Hardware timing trial (worst-case silhouette frame); run three times
node tools/shoot.mjs \
  --url http://127.0.0.1:5295/src/level/missions/foundry/harness.html \
  --out src/level/missions/foundry/evidence/timing-trial-1 --shots silhouette

npx tsc --noEmit
```

---

## Integration (for the parent)

`createFoundryLevel(options?)` is the seam. It builds the definition, derives the
static world once from the **same** solids (one-source), and mounts the shared
`ArenaLevel`:

```ts
import { createFoundryLevel } from './level/missions/foundry/index.js';
const { level, definition, staticWorld } = createFoundryLevel();
// definition.playerSpawns[0|1], definition.enemySpawn, definition.finalObjective,
// definition.routeWaypoints are all available alongside the mounted level.
```

`FoundryArenaDefinition extends ArenaDefinition`, so anything that consumes an
`ArenaDefinition` consumes this unchanged; the extra fields (`mission`,
`playerSpawns`, `enemySpawn`, `finalObjective`, `routeWaypoints`) are additive.

`createFoundryLevel` resolves **`containerDressing` to `false`** (via
`options.containerDressing ?? false`, so omitted *and* explicit-`undefined`
both mean off) because the Foundry authors no `container`-material solids — see
the first weakness below.

---

## Honest weaknesses & limitations

- **Container-dressing must be off for this arena (now enforced at the seam).**
  The shared `ArenaLevel.init` runs the cargo-specific
  `createContainerDressingLayer` after the correspondence check, and that layer
  throws on an **empty** container selection (`mergeGeometries([])`). Foundry has
  zero container solids, so `createFoundryLevel` **coalesces the option to
  `false`**: `options.containerDressing ?? false`, so both an omitted option and
  an explicit `{ containerDressing: undefined }` resolve to off (only a
  deliberate `true` re-enables it). A reproducing lifecycle gate
  (`undefined_dressing_option_safe`) locks this in — it was red before the fix
  (`Cannot read properties of undefined (reading 'index')`) and is green now.
  The residual, out-of-ownership caveat: a parent that **bypasses the helper**
  and calls `new ArenaLevel(buildFoundry(), …)` with default options still
  throws; it must pass `{ containerDressing: false }` (or `?dressing=0`). Fixing
  the shared layer to no-op on an empty list would remove that last edge but is
  out of this mission's ownership.
- **The route proof measures traversability, not AI.** A deterministic
  waypoint-follower drives the **real** `PlayerMotor` (no teleporting, gravity on,
  120 Hz fixed step); it proves a human-controlled walker can make the climb, and
  the negative control proves the proof is non-vacuous. It does **not** exercise
  enemy pathing.
- **The west climb depends on channel rails.** The six treads are flanked by
  `wall-stair-n/s` so the motor is funneled up instead of sliding off the open
  ends; without them the motor slides north and wedges at floor level (this was
  found and fixed via the analysis harness). The rails are load-bearing for the
  route gate — don't remove them.
- **Initial-LOS is a spawn-time policy.** The objective is occluded from both
  spawns at spawn eye height; it is **meant** to open up as the player advances
  up the lane (the finale reveal). Only the spawn-time occlusion is a gate. The
  enemy spawn happens to be occluded from slot 1 only — not a required property.
- **Second player slot is authored, not yet wired.** `playerSpawns[1]` is
  clearance-verified, but the shipping game is single-spawn today; the parent
  wires slot 1.
- **Single-machine performance.** Numbers are from an Apple M4 (Metal via ANGLE).
  There is ~2.5× headroom to the 16.7 ms budget, but other GPUs will differ.
- **Verbose route evidence.** `analysis.report.json` stores the full 3000-tick
  trajectory for both routes (~0.5 MB) so a reviewer can re-verify grounded-every-
  tick and rise-per-tick, at the cost of a large JSON.
