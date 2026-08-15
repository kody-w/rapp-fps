# Enemy AI — vertical slice

Refs kody-w/rapp-fps#33 (parent strategy: #32).

A self-contained enemy-AI library under `src/ai/`. One enemy type, held to a
single rule: **every state and every transition is reachable, and reachability
is proven by a fixture that fires each edge and records which one fired.** No
dead branches, no test that observes one transition while claiming another.

The enemy is meant to be worth fighting: it notices the player plausibly rather
than omnisciently, takes cover behind the arena boxes, repositions instead of
standing in the open, telegraphs its shots so a player can react, and dies
convincingly. It is beatable, and it is not a turret.

---

## What the enemy does

| behaviour | where | legibility cue in the harness |
|---|---|---|
| Limited perception | `perception.ts`, `world.ts` | gaze beam; nothing happens until the player is in the cone, in range, unobstructed, for the reaction delay |
| Line-of-sight vs. walls | `world.ts` `segmentIntersectsBox` | gaze/aim stops at a box; a player behind cover is not seen |
| Reaction delay | `config.reactionDelaySeconds` | a beat between "in view" and "engage" |
| Memory of last-seen | `agent.ts` `lastKnown` | search state hunts the last-known point, not the live player |
| Cover selection | `cover.ts` | enemy moves to a box between it and the threat |
| Repositioning | `engage → reposition → engage` | orange visor while relocating under fire |
| Telegraphed fire | `acquire → telegraph → burst → cooldown` | charging orb above the head + red aim line before the tracer |
| Death | `* → dead` | body topples to the floor, visor and effects off |

State is shown as a visor/gaze colour: patrol green · investigate amber ·
engage red · reposition orange · search yellow · dead grey.

---

## State machine and reachability

States: `patrol · investigate · engage · reposition · search · dead`.

```
                heard
   patrol ───────────────► investigate
      │  ▲                    │   │
spotted│  │lost-interest      │   │confirmed
      ▼  │        lost-sight  ▼   │
    engage ◄───┐   ┌──────► search │
      │  ▲     │   │  reacquired│  │
 repos│  │in-  │   │abandoned   │  │
      ▼  │pos  │   ▼            │  │
  reposition   └── (search → patrol)
      │
   lost-sight ► search
                                  * (any live state) ──killed──► dead
```

Eleven declared edges. The reachability fixture (`evidence/fixtures.ts`) runs a
handful of scripted scenarios under the **default config** and records the tick
and time each edge fired. `node src/ai/evidence/run.mjs` prints the table; every
row is green or the run exits non-zero.

**Why there is no `memory-expired` edge.** PR #24 was blocked because its
`search`-state `memory-expired` transition could not fire: its guard required
"no interest AND no last-known", but entering `search` always set interest, so
the committed evidence observed a *timeout* while the test claimed *memory
expiry*. Per issue #32 the right fix is to delete the unreachable transition,
not to add a test that pretends it fires. Here "memory ran out" is exactly the
`search` timeout, named honestly as `abandoned` (`search → patrol`), and it is
reachable (fixture `engage-lose-sight-abandon`, t ≈ 12.87 s). The
`killed → dead` edge is declared once as a wildcard `* → dead` and the checker
records which live states it was actually observed from (engage, patrol) rather
than asserting a fixed origin.

---

## Perception (measurable, not vibes)

Defaults in `config.ts`, all checked by fixtures:

| value | default | meaning |
|---|---|---|
| `visionDistance` | 26 m | sight reaches across the arena |
| `visionHalfAngleRadians` | 60° (120° cone) | wide but finite FOV |
| `reactionDelaySeconds` | 0.30 s | must hold the target this long before acting |
| `lostSightGraceSeconds` | 1.4 s | LOS can break briefly before the enemy gives up the fix |
| `hearingRadius` | 13 m | footsteps inside this radius trigger `investigate` |
| `aimErrorRadians` | 3.5° | shots scatter; the enemy is not pixel-perfect |
| `telegraphSeconds` | 0.45 s | wind-up window in which a player can break the shot |

Line-of-sight is a slab test of the eye→target segment against the arena AABBs
(`segmentIntersectsBox`). The negative cases are tested explicitly: a player
behind `hide-l`, behind the central pillar, behind a box straddling the
segment, behind the enemy (out of cone), and beyond vision range are all **not
seen**. A perception system that never fails to see is not a perception system.

---

## Determinism

The `EnemyAgent` is a pure function of `(seed, config, per-step inputs)`. It
reads no wall clock and no render `dt`; it advances only when `fixedStep()` is
called at the engine's 120 Hz. All randomness comes from one `SeededRandom`.

The evidence proves two things:

- **Same seed + same inputs → identical behaviour** across two runs (transition
  sequence and per-tick snapshots compared).
- **Render-rate independence**: stepping the same 1800 fixed steps while
  simulating 30, 60, 144, and 240 fps produces identical transition schedules.

---

## `src/core/collision.ts` discrepancy

The mandate said `main` contains `src/core/collision.ts` defining `StaticWorld`
with `assertValidStaticWorld`, and that line-of-sight should resolve against it.
**That file is absent on this branch.** Rather than edit `src/core/` (out of
scope), `src/ai/world.ts` owns the equivalent: a `StaticWorld` of axis-aligned
boxes, an `assertValidStaticWorld` that rejects malformed worlds at
construction, and the segment-vs-AABB occlusion test. The arena `buildArena()`
returns is shared byte-for-byte by the rendered `AiSystem` and the browser-free
evidence, so the boxes the enemy reasons about are exactly the boxes on screen.
If a real `StaticWorld` lands in core, this module should adopt it; that is a
core change and is reported, not made.

---

## Files

```
agent.ts        the FSM; renderer-free, deterministic (the heart)
perception.ts   cone + range + reaction-delay sight test
world.ts        StaticWorld, arena boxes, segment-vs-AABB line of sight
cover.ts        cover ranking/selection
config.ts       DEFAULT_ENEMY_CONFIG (all tunables)
random.ts       SeededRandom (deterministic)
math.ts types.ts  vectors and shared types
index.ts        public surface (renderer-free)
AiSystem.ts     the ONLY file that imports three; pure adapter over EnemyAgent
harness.ts/.html  standalone scene + scripted scenario for visual capture
evidence/       reachability, LOS, determinism, render-rate, CPU — and PNGs
```

`index.ts` deliberately does **not** re-export `AiSystem`, so the entry point
stays free of any renderer dependency and can be consumed by the Node evidence.

---

## Integration

`AiSystem implements System` (`name = 'ai'`, `init/fixedUpdate/update/dispose`),
matching the merged HUD/audio/FX pattern. Register it after whatever sets the
player each step:

```ts
import { AiSystem } from './ai/AiSystem.js';

const ai = new AiSystem({
  enemyId: 'grunt-1',
  playerProvider: (ctx) => ({ position: playerGroundPoint(ctx) }),
});
engine.add(ai); // fixedUpdate steps the agent at 120 Hz; update draws it
```

It listens for `Events.Damage` addressed to its `enemyId` and reports fire
events through an optional `CombatSink`.

---

## How to reproduce the evidence

Browser-free (reachability, LOS, determinism, render-rate, CPU):

```bash
node src/ai/evidence/run.mjs      # prints the tables, writes evidence/report.json, exits non-zero on any failure
```

Visual capture (requires the dev server on the explicit port):

```bash
npm exec --prefix "$PWD" -- vite "$PWD" --host 127.0.0.1 --port 5284 --strictPort
node tools/shoot.mjs --url http://127.0.0.1:5284/src/ai/harness.html \
  --out src/ai/evidence/shots --shots patrol,notice,telegraph,fire,cover,search,death
```

`tools/shoot.mjs` refuses rather than guesses (software rasteriser, no frame,
no GPU timer, too few queries, disjoint, or over budget all exit non-zero). A
refusal means UNVERIFIED. `evidence/smoke.mjs` is an optional Playwright debug
helper that prints GPU/frame status and the per-shot agent state; it is not
required to reproduce the evidence.

---

## Performance

Measured on ANGLE Metal / Apple M4.

- **CPU** (1 enemy, worst of 3 trials, first ~20 steps discarded): ≈ 0.45 µs per
  fixed step, ≈ 0.9 µs per 60 fps frame, against a 250 µs budget. The Node
  micro-benchmark is noisy across runs (~0.45–0.8 µs/step); the in-browser probe
  reports ~0.34 µs/step. Either way it is < 0.5 % of the budget.
- **GPU** (harness, worst budget-frame p95 over trials): ≈ 11.7 ms against the
  16.7 ms frame budget, 0 disjoint, 37 draw calls, 2422 triangles. The harness
  renders the whole scene, not just the enemy; the enemy's own draw cost is a
  small part of that.

---

## Assets and licence

No copyrighted assets, models, textures, audio, or trademarks. Everything is
procedural: capsule/sphere/box geometry generated at runtime, flat materials,
and the engine's existing HDR/AgX pipeline. No third-party content is bundled by
this library. This subsystem is released under the repository's licence.
