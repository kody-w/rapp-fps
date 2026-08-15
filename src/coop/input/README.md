# Co-op gamepad / player-slot input

A self-contained input library that presents a **standard gamepad** as the
engine's existing `InputState` (`src/core/contracts.ts`), one instance per
**player slot**. It exists so couch co-op can drive two (or more) independent
players from two (or more) controllers, with a hard guarantee the code is built
to prove: **two device indices never bleed into one another.**

Built for issue **#71**. Everything ships under `src/coop/input/**`. The library
imports exactly one thing from the rest of the codebase — the `InputState`
*type* — and that import is erased at compile time (`import type` under
`verbatimModuleSyntax`). It does **not** touch `main.ts`, the player, the
renderer, or any other subsystem's runtime.

## Why a seam sits between this and the browser

Nothing here reads `navigator`, `window`, or a live `Gamepad` directly. Devices
arrive through a `GamepadSource`, lifecycle notifications through an
`EventTargetLike`. Production wires the browser-backed implementations; a Node
fixture wires deterministic doubles. That single indirection is what lets the
isolation guarantee be *proven*, headless and hardware-free, over the exact
modules that ship — see [`fixtures/`](./fixtures) and
[`evidence/report.json`](./evidence/report.json).

## The exact mapping

A device must advertise the W3C **`"standard"`** mapping
(<https://www.w3.org/TR/gamepad/#remapping>), which fixes the axis and button
indices below across Xbox, PlayStation and most third-party pads. Non-standard
pads are refused by default rather than guessed at (see *Validation*).

### Sticks → `move` and `look`

| Axis | Standard control     | Drives                    | Sign convention |
|:----:|----------------------|---------------------------|-----------------|
| 0    | Left stick X         | `move.x`                  | right = `+1`    |
| 1    | Left stick Y         | `move.y`                  | forward = `+1` (stick up); the raw down-positive axis is negated |
| 2    | Right stick X        | `look.x` (yaw)            | right = positive; consumer applies `yaw -= look.x` |
| 3    | Right stick Y        | `look.y` (pitch)          | non-inverted default: stick **up** looks up; `invertLookY` flips it |

`move` is radially deadzoned and normalised so its magnitude never exceeds 1 and
a diagonal keeps its true angle. `look` is a **per-frame delta in radians** and
is **frame-rate independent**: the stick expresses a turn *rate*, so the delta
is `shapedComponent × radiansPerSecond × dt`. Movement takes no `dt`; look does.

### Buttons → actions

| Button | Standard control            | Action    |
|:------:|-----------------------------|-----------|
| 0      | A / Cross (bottom face)      | `jump`    |
| 1      | B / Circle (right face)      | `crouch`  |
| 2      | X / Square (left face)       | `reload`  |
| 6      | LT / L2 (left trigger)       | `aim`     |
| 7      | RT / R2 (right trigger)      | `fire`    |
| 10     | L3 (left stick click)        | `sprint`  |

Triggers (`aim`, `fire`) are analog: an action counts as held when the digital
`pressed` flag is set **or** the analog `value` reaches `triggerThreshold`
(default `0.5`). `pressed(action)` is **edge-triggered** — true only on the frame
a button transitions from up to down. A button held across a connect or a
focus-return does **not** fire a phantom edge.

The mapping is exported as `STANDARD_GAMEPAD_MAPPING`, and the table above is the
same data the code and the fixtures read, so they cannot drift.

## Quick start

```ts
import { CoopInputManager } from './coop/input/index.js';

// In a browser: seams default to navigator/window.
const coop = new CoopInputManager();

const p1 = coop.join('p1', 0); // slot id, gamepad index
const p2 = coop.join('p2', 1);

function frame(dt: number): void {
  coop.sample(dt);            // polls every slot's own device
  drivePlayer(p1);           // p1 is an InputState: move, look, jump, pressed()…
  drivePlayer(p2);
}
```

`join` returns a `GamepadInput`, which **is** an `InputState`. The host loop
calls `coop.sample(dt)` once per frame; each slot reads only its own device.

## Lifecycle — nothing sticks

Every transition funnels through a single "release all" so a held action can
never survive it:

- **Connect** — the first sample that sees a device adopts its held state
  without firing edges.
- **Disconnect while held** — detected by poll (device gone) *or* by the
  `gamepaddisconnected` event (released immediately, before the next poll). All
  of `move`, `look`, and every action are zeroed; the slot stays joined and
  resumes cleanly if the device returns.
- **Focus loss** — `blur` suspends every slot: held state releases now, and
  further samples yield neutral state until `focus`. (Polling a physically-held
  button while the tab is unfocused must not re-apply it.)
- **BFCache** — `pagehide` suspends; a **persisted** `pageshow` (restore from the
  back/forward cache) resumes; a non-persisted `pageshow` does not. `dispose`
  removes every listener, so no handler leaks across a real navigation.
- **Rejoin** — `leave(slot)` then `join(slot, index)` yields a fresh instance
  with no stale state; a device that reconnects on the same index resumes
  sampling without a phantom edge.

You can also drive these by hand: `suspendAll()`, `resumeAll()`, `dispose()`, and
per-slot `suspend()`, `resume()`, `release()`, `dispose()`. Pass `events: null`
to opt out of automatic wiring entirely.

## Validation — loud over silent

The design rule is **prefer a loud typed error over a silently-accepted
malformed device.** During `sample`, the bound device is validated before it can
touch state:

| Condition                                   | Response                              |
|---------------------------------------------|---------------------------------------|
| Axis is `NaN` / `±Infinity`                 | **Refuse** — `NonFiniteAxisError`     |
| Mapped button `value` is `NaN` / `±Infinity`| **Refuse** — `NonFiniteButtonError`   |
| Too few axes or buttons for the mapping     | **Refuse** — `MalformedGamepadError`  |
| Button entry not a `{ pressed, value }`     | **Refuse** — `MalformedGamepadError`  |
| `mapping !== "standard"` (default)          | **Refuse** — `UnsupportedMappingError`|
| Axis finite but outside `[-1, 1]`           | **Clamp** to `[-1, 1]`                |
| Button `value` finite but outside `[0, 1]`  | **Clamp** to `[0, 1]`                 |
| `dt` non-finite or negative                 | **Refuse** — `InvalidTimeStepError`   |
| `dt` very large (tab stall)                 | **Clamp** to `maxTimeStepSeconds`     |

On refusal the offending slot is released first, so a caught error never
corresponds to a stuck button. `manager.sample(dt)` samples **every** slot even
when one faults — isolation holds — then throws an `AggregateError` carrying the
per-slot typed errors. A host that would rather keep running calls
`manager.pollSlots(dt)`, which returns the faults instead of throwing. All error
types extend `CoopInputError` and carry a stable `code` plus the slot and device
index for diagnostics.

Non-finite values are *refused* because they are corruption with no safe
interpretation; out-of-range finite values are *clamped* because a driver
reporting a hair beyond ±1 is a range quirk, not a broken device.

## The isolation guarantee, and how it is proven

Each `GamepadInput` is bound at construction to one device index and only ever
calls `source.poll(thatIndex)`. There is no shared mutable state between two
slots — that is the structural reason indices cannot bleed.

[`fixtures/two-slot-isolation.ts`](./fixtures/two-slot-isolation.ts) proves the
*behaviour* deterministically, and is honest about its own power: every isolation
claim is paired with a **negative control** that runs the same predicate against
a deliberately non-isolated setup (two slots on one index; two devices driven
identically) and asserts the predicate reports the bleed. A green check means
nothing unless the same check can go red on purpose — the controls show it can,
and a mutation that makes a slot poll the wrong index turns exactly the
cross-device checks red while the controls stay green.

The suite covers all the lifecycle cases above plus deadzone, normalisation,
frame-rate-independent look, dt clamping, the full button mapping, and
isolation-under-fault (one slot's malformed device does not disturb its peer).

### Running the proofs

```
# Browser-free, deterministic — compiles the real modules and runs in Node:
node src/coop/input/fixtures/run-isolation.mjs      # writes evidence/report.json

# The same suite inside real headless Chromium (needs vite + playwright):
node src/coop/input/fixtures/run-isolation-browser.mjs  # writes evidence/report.browser.json

# Whole-repo type check:
npx tsc --noEmit -p tsconfig.json
```

## Configuration

`CoopInputManager({ config })` accepts a partial `GamepadConfig`, merged onto
`DEFAULT_GAMEPAD_CONFIG` and range-validated:

| Field                         | Default        | Meaning                                            |
|-------------------------------|----------------|----------------------------------------------------|
| `stickDeadzone`               | `0.15`         | Radial inner deadzone, both sticks                 |
| `stickOuterZone`              | `0.05`         | Radial outer margin; saturates to full past it     |
| `triggerThreshold`            | `0.5`          | Analog trigger value that counts as a press        |
| `lookSpeedRadiansPerSecond`   | `{x:3.2,y:2.4}`| Look rate at full right-stick deflection           |
| `invertLookY`                 | `false`        | Invert vertical look                               |
| `maxTimeStepSeconds`          | `0.1`          | Upper clamp on `dt` for look integration           |
| `requireStandardMapping`      | `true`         | Refuse non-`standard` devices                      |

## Honest limits

- **Standard mapping only.** Non-`standard` pads are refused unless you set
  `requireStandardMapping: false`, which trusts the device's indices blindly —
  there is no per-vendor remapping table.
- **No remap UI, no rumble/haptics.** Bindings are the fixed table above;
  output-only features (vibration) are out of scope.
- **Actions are binary.** `fire`/`aim` are thresholded triggers, not graduated
  analog values; there is no partial-pull output.
- **Look is linear.** A single per-axis rate, no acceleration curve or aim
  smoothing. `dt`-scaled and stall-clamped, but not otherwise shaped.
- **Explicit slots only.** The manager never auto-joins on
  `gamepadconnected`; it exposes an `onDeviceConnected` hook and leaves the
  policy (which pad becomes which player) to the host.
- **No internal loop.** The library samples when the host calls `sample(dt)`; it
  runs no `requestAnimationFrame` of its own and does no interpolation.
- **Same-index slots are allowed.** Two slots may share a device index (the
  negative control relies on it); production couch co-op should bind distinct
  indices.
- **Browser gesture gate.** Some browsers expose gamepads only after a user
  gesture; the library reports whatever the source reports and cannot conjure a
  device the browser withholds.

## Files

| File                          | Role                                                        |
|-------------------------------|-------------------------------------------------------------|
| `index.ts`                    | Public surface                                              |
| `CoopInputManager.ts`         | Slots, join/leave, frame sampling, lifecycle event wiring   |
| `GamepadInput.ts`             | One slot as an `InputState`; polling, shaping, edges         |
| `mapping.ts`                  | Standard axis/button indices and the action binding         |
| `config.ts`                   | `GamepadConfig`, defaults, deadzone / look maths            |
| `seams.ts`                    | Seam interfaces + browser-backed source / event target      |
| `scripted.ts`                 | Deterministic `ScriptedGamepadSource` / `ManualEventTarget` |
| `errors.ts`                   | Typed `CoopInputError` family                               |
| `types.ts`                    | Shared vocabulary (`PlayerSlotId`, snapshot shapes)         |
| `fixtures/`                   | Deterministic proof + browser harness + runners             |
| `evidence/`                   | Archived reports from the runners                           |
