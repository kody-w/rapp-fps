# Mission 2 — RELAY BLACKOUT

A second **blue-hour, rain-wet arena** for the campaign (issue #72, parent #70):
a flooded electrical **relay / utility switchyard**. The player deploys at the
south gate, weaves two staggered transformer aisles around a central
switch-house, climbs a **six-step stair** onto a raised **control deck** and
holds the **relay objective** — a status-beacon cabinet against the north wall.

It is authored the same way as the cargo bay (issue #32) and reuses its
contracts and helpers **by import only**. Everything in this mission lives under
`src/level/missions/relay/**`; **no shared file is edited**. The parent
integrates the exports.

```ts
import { createRelayLevel } from './level/missions/relay/index.js';

// createRelayLevel() composes the shipping ArenaLevel from the mission
// definition + world. It resolves `containerDressing` to `false` for you
// (the relay palette never uses the `container` material, and ArenaLevel's
// default-on dressing THROWS on that empty selection — see below), so this is
// safe on the default path. Read `.definition` / `.staticWorld` off the level
// to wire the two deploy pads, the enemy spawn and the objective.
engine.add(createRelayLevel());
```

> **Integration footgun (closed here).** `buildRelayArena()` declares no
> `container` solids, but `ArenaLevel` defaults its container dressing **on**,
> and that path throws on an empty selection
> (`createContainerDressingLayer([])` → `mergeGeometries([])`). A raw
> `new ArenaLevel(buildRelayArena(), buildStaticWorld(def))` therefore **crashes
> in `init`** unless the caller remembers `{ containerDressing: false }`.
> `createRelayLevel(options?)` always resolves `containerDressing` via
> `options.containerDressing ?? false` (including an explicit `undefined`), so
> the mission mounts safely. The shared root cause — `ArenaLevel` defaulting
> dressing on for a container-less definition — is the parent's to harden; this
> mission only makes its own composition safe. The `relay-integrity` fixture
> asserts both halves (raw default throws; factory survives).

## The one rule (inherited, unchanged)

**Rendered geometry and collision are the same data.** Every piece of the level
is a single `Solid` record — an axis-aligned box with a `MaterialKey`, a
`SurfaceMaterial` and a `collide` flag (`src/level/arena.ts`). The meshes come
from `mergeSolidsByMaterial`, the `StaticWorld` from `buildStaticWorld`, and
`checkCorrespondence` **proves** the two agree against the real merged buffers.
The relay factory produces `Solid[]` in exactly that shape, so all of that
shared machinery consumes it with zero changes.

`RelayArenaDefinition extends ArenaDefinition`: it adds `mission`,
`playerSpawns` (two co-op deploy pads), `objective` and `los` (the declared
sightline policy), and sets the base `playerSpawn` to pad A so it stays a valid
`ArenaDefinition` everywhere.

**AABB only. No slopes. No downloaded assets, textures, meshes, fonts or
trademarks** — every material is the fixed procedural palette from
`materials.ts`; every shape is a box.

## Layout (why it is not a recoloured cargo bay)

```
                    N (control deck, relay objective + beacon)
        ┌───────────────── deck ─────────────────┐
        │  relay-core ▉  (hold behind it)         │   DECK_TOP 1.6 m
        │            ▂▄▆ six-step stair ▆▄▂        │   rise 0.267 m / step
   w2 ▉                    │ x=0 │                   ▉ e2   staggered rear guard
        │      ▉ switch-house (screens W pad) ▉    │
   w1 ▉  ← near transformer gate → ▉ e1             (each pad north-blocked)
        │   pad A ●              ● pad B            │   feet y=0, eye 1.66 m
        └──── south gate: pier | gantry | pier ────┘
                    S (switchyard entry)
```

- **Bounds** `29.2 × 6.2 × 23.2 m` vs cargo `25.2 × 6.6 × 22.2` — wider and
  shallower by construction.
- **Two columns of transformer tanks** (x ≈ ±4.2) make a west lane, a central
  approach and an east lane; a **central switch-house** splits the middle so the
  route weaves through a ~1.3 m throat on either side.
- **Central head-on stair** to a north-wall deck that **carries the mission
  objective** — cargo's deck is on the east wall and holds nothing.
- **Cable-trench dressing, overhead bus ducts, transformer bushings, a status
  beacon and safety-yellow route bands** — all AABB, all render-only, none
  body-height, so they shape the look without lying about collision.

## What is proven, and where

Four fixtures drive the **real shipping modules** in a browser (the factory is
TypeScript 7 native, which cannot run `.ts` in plain Node, so — exactly like the
repo's existing fixtures — validation runs through vite + playwright). All
evidence is archived under `evidence/`.

### 1. Topology / clearance / LOS — `relay-topology.harness.mjs`
Builds the mission and the cargo bay, compares them with the committed
`compareTopology`, and measures every gate. Archived:
`evidence/relay-topology.report.json`.

- **Distinct on all four required axes** vs cargo: bounds differ; **id set**
  differs (18 ids unique to relay, 16 unique to cargo, only 13 shared — the
  reused shell vocabulary `floor/wall/deck/step/parapet`); **route graph**
  differs (2 spawns vs 1, an objective vs none, different deck centroid);
  **sightline signature** differs (blocked 66/98 hash `2314055479` vs 74/98 hash
  `166094059`).
- **≤ 45 collidable boxes:** **31**.
- **Two co-op deploy pads**, both fit a standing capsule (shipping
  `StaticBoxWorld.canFit`), rest on the floor, in bounds, not inside any solid.
- **Enemy spawn** fits and is not inside a solid.
- **6 authored cover ids**, every one collidable: `transformer-e2`,
  `transformer-w2`, `relay-core`, `drum-n`, `relaybox-e`, `switchhouse` (≥ 4).
- **LOS measured at the real 1.66 m eye height and matched to the declared
  policy** (not accidental): enemy → **both** pads **blocked** (safe co-op
  deploy); pad A ↔ pad B **clear** (co-op cohesion); **both** pads → objective
  **blocked** (the raised relay is a fought-for hold, screened symmetrically by
  the near transformer gate); enemy → objective **clear** (the defender holds
  it).

### 2. Deploy → deck traversal — `relay-traversal.harness.mjs`
Drives the **shipping `PlayerMotor` + `StaticBoxWorld`** at 120 Hz from **both**
pads with a deterministic **waypoint follower** (ordinary WASD intent — compute
yaw toward each waypoint, hold forward; no teleport, no `motor.position =`).
Archived: `evidence/relay-traversal.report.json`.

- Both pads **start on the floor** (feet y ≈ 0, grounded), **stay grounded the
  whole climb (0 airborne ticks)**, every step-up is **0.267 m ≤ 0.34 m**, reach
  the deck and **finish standing at the objective** (within 0.16 m).
- Every authored ground waypoint is asserted to fit a standing capsule before
  the drive, so a layout change fails the fixture instead of walking into a wall.
- **Negative control (non-vacuous):** the same west route against a world with
  the `step-*` treads removed **cannot reach the deck** — it stops at the 1.6 m
  deck face. The stairs are load-bearing; the success is real.

### 3. Correspondence + lifecycle + integration footgun — `relay-integrity.harness.mjs`
Mounts the mission through the shipping `ArenaLevel` against a **real
`THREE.WebGLRenderer`**. Archived: `evidence/relay-integrity.report.json`.

- **All five correspondence checks green** against the real merged buffers:
  `core-contract`, `box-count` ("31 boxes vs 31 collidable solids"), `bijection`,
  `render-backing`, `render-membership`.
- **Build → dispose → rebuild:** dispose removes the arena root, deletes the
  `__SHOT__`/`__ARENA_CHECK__` globals and **releases GPU geometry (9 → 0)**; a
  fresh rebuild on a new scene passes correspondence again and is byte-identical
  to the first build.
- **Container-dressing footgun (red on default, green through the factory):**
  a raw `new ArenaLevel(def, world)` with **default** options **throws** in
  `init` (container dressing has an empty selection on a relay with no
  `container` solids); `createRelayLevel()` — and `createRelayLevel({
  containerDressing: undefined })` — mounts cleanly and builds no dressing layer.
  Both halves are asserted, so the fix cannot silently regress.

### 4. Hardware frames + budget — `harness.ts` via `tools/shoot.mjs`
Six procedural frames at **1920×1080** on hardware (Apple M4, ANGLE Metal),
**3 trials**, archived under `evidence/shots/` + `evidence/shoot.trial-{1,2,3}.json`.

| trial | budget p95 | draws | tris | console errors |
|------:|-----------:|------:|-----:|---------------:|
| 1 | **7.358 ms** | 24 | 1110 | 0 |
| 2 | **7.212 ms** | 24 | 1110 | 0 |
| 3 | **7.155 ms** | 24 | 1110 | 0 |

All well under the **16.7 ms** frame budget; 12 programs, 22 textures, 13
geometries. Frames: `spawn`, `switchyard`, `stairs`, `controldeck`, `objective`,
`silhouette`.

## Running it yourself

```bash
# 1. dev server on the mission's port (do NOT edit vite.config.mjs — CLI wins)
npx vite --host 127.0.0.1 --port 5294 --strictPort

# 2. the three analysis fixtures (exit non-zero on any failure)
node src/level/missions/relay/fixtures/run-relay-topology.mjs  --url http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-topology.harness.html
node src/level/missions/relay/fixtures/run-relay-traversal.mjs --url http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-traversal.harness.html
node src/level/missions/relay/fixtures/run-relay-integrity.mjs --url http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-integrity.harness.html

# 3. hardware frames + timing (repeat for trials)
node tools/shoot.mjs --url http://127.0.0.1:5294/src/level/missions/relay/harness.html \
  --out src/level/missions/relay/evidence/shots \
  --shots spawn,switchyard,stairs,controldeck,objective,silhouette --width 1920 --height 1080

# 4. typecheck (the .ts files; .mjs fixtures are runtime glue, excluded by allowJs=off)
npx tsc --noEmit
```

## Files

| file | role |
|------|------|
| `relayArena.ts` | the pure factory `buildRelayArena()` + extended types |
| `relayLevel.ts` | `createRelayLevel(options?)` — safe `ArenaLevel` factory (resolves `containerDressing ?? false`) |
| `topology.ts` | fingerprint + `compareTopology` + AABB segment raycast (LOS) |
| `index.ts` | public surface for the parent (`createRelayLevel`, `buildRelayArena` + types + topology) |
| `harness.ts` / `.html` | mounts the mission through `ArenaLevel` for shot/correspondence evidence |
| `fixtures/*.harness.mjs` / `.html` | the three browser fixtures (topology, traversal, integrity) |
| `fixtures/run-*.mjs` | playwright runners that archive JSON and exit non-zero on failure |
| `evidence/*` | committed reports, 3 timing trials, and six 1920×1080 frames |

## Honest weaknesses

1. **The one-enemy slice is deliberately small.** This is a compact vertical
   slice: one enemy spawn, no patrol/AI, no spawn director, no scoring. The
   second player spawn is authored and proven walkable but there is no co-op
   session logic yet — that is the parent's integration, not this mission.
2. **LOS is a static, first-contact measurement**, computed against solid AABBs
   at standing eye height for the exact spawn/enemy/objective points. It proves
   the *initial* policy (safe deploy, screened objective) is intentional; it does
   **not** model crouch, moving sightlines, projectile arcs, or the low
   crouch-cover interplay. The two throats that make the objective screening
   symmetric give a real but modest ~0.3 m capsule clearance on each side — wide
   enough for the motor (proven), tight enough that a future wider enemy hull
   would need re-checking.
3. **The traversal route is an authored waypoint follower, not a general
   pathfinder.** It proves a *deterministic* human-walkable path exists from each
   pad to the objective (with a negative control); it is not a nav-mesh and makes
   no claim about every possible route. The waypoints are geometry-derived and
   capsule-gated, so they fail loudly on layout drift rather than silently.
4. **Validation is browser-only by necessity.** The repo pins TypeScript 7's
   native compiler, which exposes no `transpileModule` and cannot execute `.ts`
   in Node, and no esbuild is vendored. Like every existing fixture here, the
   proofs therefore run through vite + playwright rather than a Node unit test.
   This is faithful to the shipping modules but heavier than a pure unit test.
5. **Visual evidence is a fixed six-shot set** on one machine's GPU (Apple M4 /
   ANGLE Metal). The budget headroom is large (~7.3 ms p95 vs 16.7), but numbers
   on lower-end hardware will differ; the shot tool refuses a software rasteriser
   so those frames are never silently substituted.
6. **The status beacon can read as a dark monolith from due south** at deploy
   (it is unlit geometry crowned by the emissive cap); it resolves clearly from
   every other angle and on the deck. A future pass could add a second practical
   to light its south face.
