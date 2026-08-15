# Player locomotion subsystem

First-person locomotion for the engine: mouse-look with pointer lock,
walk / sprint / crouch / jump, step traversal, wall collision, and a camera
tuned to read as *crisp* rather than floaty or nauseating. It runs on the
engine's 120 Hz fixed step and is frame-rate independent, and it emits the
existing bus events so audio, HUD and FX react without knowing the player
exists.

Built for issue **#36** (parent **#32**). The strategy of #32 is the reason this
subsystem looks the way it does: **land the proven locomotion subset now, and
make the unverified slope path structurally unreachable.** Everything below
follows from that.

## The one contract that shapes everything: axis-aligned boxes only

The world is a `StaticWorld` from `src/core/collision.ts` — **only axis-aligned
boxes**. `StaticBoxWorld.fromStaticWorld` runs `assertValidStaticWorld`, which
**throws** at registration on a degenerate, out-of-bounds, or (by construction)
non-axis-aligned solid. There is no export anywhere in this subsystem that
ingests arbitrary meshes.

That is deliberate. The prior controller (draft PRs #3/#13) used a mesh/BVH
capsule solver that pops the body upward by **116–154 mm in a single tick** on a
finite walkable ramp while reporting itself grounded — see
[`fixtures/README.md`](./fixtures/README.md) for the re-runnable witness. Rather
than ship a slope solver we could not verify, this slice removes the ability to
*express* a slope. The defect is unreachable, not merely untested. Slopes return
later under their own issue, and a future slope solver must pass that fixture
before it ships.

Against the box contract a swept capsule is exact and cheap: every floor normal
is `+Y`, every wall normal is horizontal, and there is no
closest-point-on-triangle to get subtly wrong. Wall sliding falls out of
penetration resolution for free.

## Public API

From `src/player/index.ts`:

```ts
// Browser: pointer-lock input + system, wired to a canvas.
const { input, system } = createPlayer(canvas, { world, spawn });

// Headless / harness: supply your own InputState (or undefined).
const system = createPlayerWithInput(inputState, { world, spawn });
```

`PlayerSystem` is an engine `System`: `engine.add(system)`. Pass the **same**
`StaticWorld` the level's meshes were generated from, so what is drawn is what is
collided.

Also exported: `PlayerMotor` (the pure fixed-step motor), `StaticBoxWorld` (the
solver), `PlayerInput`, `PlayerCalibrationLevel` / `createPlayerCalibrationWorld`,
and `DEFAULT_PLAYER_TUNING` with the `PlayerTuning` type.

## Architecture

| file | role |
| --- | --- |
| `config.ts` | Frozen `DEFAULT_PLAYER_TUNING` — feel is a data decision, one source of truth every harness measures against. No walkable-slope knob exists, on purpose. |
| `StaticBoxWorld.ts` | The exact AABB swept-capsule solver. `moveCapsule` resolves penetration, traverses steps ≤ `maxStepHeight`, and ground-snaps within `groundSnapDistance`. Registration guard lives here. |
| `PlayerMotor.ts` | Fixed-step, frame-rate-independent motor: acceleration curves, ground/air control, crouch with a headroom check, coyote time, jump buffering, sprint stamina, distance-based footsteps, landing impact. The proven feel from PR #3/#13, moved intact onto the box solver. |
| `PlayerInput.ts` | Browser input: pointer lock, mouse-look (accumulated in radians), WASD / jump / crouch / sprint bindings, presented through the engine `InputState` so the motor never touches the DOM. **Look is gated on pointer lock being _requested_, not _held_** — see [below](#mouse-look-the-pointer-lock-seam). |
| `PlayerSystem.ts` | Glue: `fixedUpdate` drives the motor; `update` is pure presentation — look, interpolated position, crouch eye-height, view bob, a landing-dip spring, and a step-smoothing offset so stairs read as a glide. Cosmetic view effects are applied around the draw and **restored**, so `engine.camera` reports the true eye pose between frames. Emits the bus events. |
| `PlayerCalibrationLevel.ts` | A box arena whose meshes are generated from the same box list used for collision, so every visual and collision claim points at one geometry. |

### Fixed step vs. render

`fixedUpdate(dt)` runs the motor at the constant 120 Hz step; `update(dt, alpha)`
only presents (interpolating between the last two motor states). This is what
makes the result frame-rate independent, and the numeric harness proves it:
running the same inputs batched at 30 fps and 144 fps yields **bit-identical**
position and velocity.

### Events emitted (existing bus vocabulary)

- `Events.Footstep` (`player:footstep`) — `{ position, surface, loud }`, on each
  distance-based step; `loud` when sprinting.
- `Events.Landed` (`player:landed`) — `{ impactSpeed }`, on ground contact after
  a fall.

Both are the contracts the merged audio / HUD / FX subsystems already listen
for; the player publishes, it does not reach into them.

### Mouse-look: the pointer-lock seam

A real player gets real pointer lock: click captures the pointer, Escape
releases it, and `pointerlockchange` / `pointerlockerror` are handled. But the
**look delta path must not be gated on the lock being _held_.** Pointer lock
cannot be granted under browser automation on this machine — headless silently
declines (`document.pointerLockElement` stays `null`, no error), headed raises
`pointerlockerror`. So any code that gates look on `document.pointerLockElement`
makes mouse-look **permanently unverifiable by automated evidence**, which under
this project's rules means UNVERIFIED, which means it cannot ship.

`PlayerInput` therefore gates look on a self-owned `lockRequested` flag, set the
moment the user clicks and `requestPointerLock()` is called — **not** on the
grant. A `mousemove` carrying `movementX` / `movementY` drives look through the
identical code path whether the delta came from a locked pointer or a dispatched
event, so sensitivity, axis mapping, accumulation, pitch clamping and smoothing
are all genuinely exercised. Only the browser's lock **grant** is unverified,
and that gap is recorded here rather than hidden. A genuine exit (held → not
held, i.e. Escape or focus loss) disarms look; a spurious change that never
granted the lock does not, so the seam never dies on a machine that declines it.

### The camera is authoritative between frames

Cosmetic view effects — head-bob, the landing dip, step-glide, bob-roll — are
presentation, not camera state. `update()` writes the **true** eye pose (position
+ look angles) to `engine.camera`; the transient effects are applied by
`applyViewEffects()` immediately before the draw and undone by `restoreView()`
immediately after, the same non-destructive bracket `RenderSystem` uses for
camera shake. The presenter pairs them around `render()` (see `harness.ts`, and
mirror it wherever the game wires its own present). The result: AI, networking,
and this project's acceptance instrument all read the player's true position
between frames, never a pose dressed with cosmetic motion.

## Feel — every number has a witness

`harness-report.ts` is a pure, deterministic harness (`runPlayerHarness()`) of
**24 assertions**. It is executed **inside the shipping bundle** in a real
GPU-backed browser by `tests/run-motor-tests.mjs`, which writes
`evidence/motor-report.json`. Current result: **24 / 24**, including —

- walk reaches 95% speed in 0.16 s; release-to-stop in 0.19 s; stopping distance
  0.50 m (under one body length),
- jump apex 1.02 m against a 1.05 m tuning; air control useful but cannot reverse
  at ground authority,
- crouch transition 0.125 s, crouch top speed 2.65 m/s, sprint top speed
  7.5 m/s, sprint stamina ~44% after 2 s,
- 0.30 m step traversed; 0.80 m wall refused and not climbed; diagonal-into-wall
  slides,
- staircase descent stays grounded with the step-down bounded by the riser (no
  free-fall),
- fixed-step determinism (≤ 1e-9), CPU **0.002 ms / tick** (budget 0.25 ms), and
  the three registration guards throwing on degenerate / out-of-bounds / empty
  worlds.

### CPU cost caveat

The 0.002 ms figure is a headless estimate (`µs/tick × 2` for a 60 fps-equivalent
two-substep budget) on a nearly empty calibration world. It is far under the
0.25 ms budget, but it is not a busy-scene measurement; treat it as "cheap by a
wide margin", not "0.002 ms in the shipping game".

## Visual + GPU evidence

`harness.html` / `harness.ts` boot the real engine and render pipeline over the
calibration level and expose the window API `tools/shoot.mjs` needs
(`window.engine`, `__SCENE_STATS__`, `__FRAME_READY__`, and named `__SHOT__`
poses). It wires a real `PlayerInput` on the canvas and brackets the present hook
with the view-effect apply/restore — the way the game would integrate the player.
(`src/main.ts` currently ships an input stub with no player; wiring it in means
adding the system and the same present bracket.) Run it, then capture:

```sh
# dev server (explicit port; the harness is served at /src/player/harness.html)
npm exec --prefix "$PWD" -- vite "$PWD" --host 127.0.0.1 --port 5281 --strictPort

# numeric proof, in-bundle (writes evidence/motor-report.json)
node src/player/tests/run-motor-tests.mjs

# GPU frame timing + calibration screenshots at 1920x1080
node tools/shoot.mjs --url http://127.0.0.1:5281/src/player/harness.html \
  --out shots/player --shots default,top-of-step,at-wall,on-stairs,crouched
```

GPU frame p95 over three trials on this machine (ANGLE Metal / Apple M4,
1920×1080): **11.69 / 11.90 / 11.46 ms — worst-of-three 11.90 ms** against the
16.7 ms budget, 0 GPU disjoint, no console errors. GPU clocks on this machine are
dynamic, so one capture qualifies nothing; the worst of three is reported. The
calibration scene is intentionally light (≈54 draw calls); the game arena will
cost more, so this is headroom for the *player*, not a whole-game budget.

`?shot=<name>` drives a named pose; the poses match the calibration geometry
(`default`, `top-of-step`, `at-wall`, `on-stairs`, `crouched`, `mid-air`,
`landing`). The on-stairs capture carries a debug HUD that prints the player
state (`grounded`, `feet y`, `speed`, capsule size) so a visual claim is backed
by numbers in the same frame.

## Acceptance: `tools/verify-slice.mjs`

The independent acceptance instrument (authored on `main` before this work, so it
cannot be shaped to fit it) drives real DOM input at the harness and asserts
behaviour it can observe. Its rule: *a check that could not be observed is not a
pass.* Run it against the same dev server:

```sh
node tools/verify-slice.mjs \
  --url=http://127.0.0.1:5281/src/player/harness.html --out=shots/slice
```

Result on this machine (`shots/slice/slice.json`):

| check | verdict | evidence |
| --- | --- | --- |
| `look` | **pass** | yaw changed 1.296 rad under 30 dispatched mouse-delta events — the seam, exercised without a lock grant |
| `look_pitch_clamped` | **pass** | pitch held within ±1.5718 rad when driven hard past vertical both ways |
| `move` | **pass** | 7.66 m travelled in 1.5 s of forward input |
| `move_stops` | **pass** | coasted 0.62 m after release (< 1.0 m) |
| `footsteps` | **pass** | 4 `player:footstep` events while moving |
| `containment` | **pass** | stopped at the perimeter wall, 20.5 m from start, never fell |
| `frame_budget` | **pass** | 14.04 ms p95 measured *while moving and turning* (179 paired samples), budget 16.7 ms |
| `no_console_errors` | **pass** | none across the whole sequence |
| `weapon_fires` / `bullet_resolves` / `enemy_damageable` | **unobserved** | there is no weapon or enemy in this build — out of scope for a locomotion slice |

Verdict **INCOMPLETE** (exit 12): every player-locomotion check passes; the three
combat checks are *unobserved*, not failed, because this slice ships no weapon or
enemy. That is the honest outcome for a player-only PR — an INCOMPLETE here means
"this build did not demonstrate combat", which is true, not "locomotion is
broken". The `frame_budget` figure (14.04 ms under motion) is higher than the
idle-capture worst-of-three above (11.90 ms) because it is measured under active
input; both are under budget.

## Licence / assets

No copyrighted or third-party assets. This subsystem ships **zero binary
assets** — every mesh in the calibration level is generated procedurally from
the collision box list, and materials are solid-colour PBR. Code is under the
repository licence (ISC). The only third-party code touched is the vendored PR
#13 solver used *only* by the offline fixture, which is the project's own prior
work (git ref `20c038f`), cited in `fixtures/pr13-mesh-solver.mjs`.

## What this subsystem does not do

- **Slopes / arbitrary meshes.** By design and by throw. See above and
  `fixtures/`.
- **Moving platforms, ladders, mantling, swimming.** Out of scope for the slice.
- **Weapons, bullets, enemies.** Out of scope — `verify-slice.mjs` reports these
  three as *unobserved*, which is why its overall verdict is INCOMPLETE, not
  verified. A locomotion slice cannot demonstrate combat.
- The **pointer-lock grant itself** is not verified. Automation cannot obtain a
  lock on this machine, so the seam verifies everything downstream of the delta
  (sensitivity, mapping, accumulation, clamping) but not the browser granting the
  lock. That gap is structural to the environment, recorded, not papered over.
- The **camera step-down smoothing** that hides stair risers is validated
  visually (the on-stairs capture) and by the "grounded throughout / bounded
  step-down" numeric assertions, but there is no numeric assertion on the
  *smoothed camera curve* itself — that remains a feel judgement.
