/**
 * Deterministic two-slot isolation proof for the co-op gamepad input library.
 *
 * This fixture is browser-free and hardware-free: it wires a
 * `ScriptedGamepadSource` and a `ManualEventTarget` into a real
 * `CoopInputManager` and drives the exact modules that ship. Its central claim
 * is that two device indices never bleed into one another — slot A reads device
 * 0, slot B reads device 1, and nothing one does reaches the other — across the
 * whole lifecycle the task calls out: connect, disconnect-while-held, focus
 * loss, BFCache suspend/resume/dispose, rejoin, NaN / out-of-range axes, and
 * the full button mapping.
 *
 * It is honest about its own power. Every isolation claim is paired with a
 * NEGATIVE CONTROL that runs the same predicate against a deliberately
 * non-isolated setup and asserts the predicate REPORTS the bleed. A green
 * isolation check means nothing unless the same check can go red on purpose;
 * the controls prove it can.
 *
 * `runIsolationSuite()` returns a plain report; the Node runner and the browser
 * harness both call it, so the two front-ends prove the identical logic.
 */

import {
  ACTION_BUTTON,
  BUTTON,
  CoopInputManager,
  DEFAULT_GAMEPAD_CONFIG,
  GAMEPAD_ACTIONS,
  MalformedGamepadError,
  ManualEventTarget,
  NonFiniteAxisError,
  ScriptedGamepadSource,
  STANDARD_GAMEPAD_MAPPING,
  UnsupportedMappingError,
  makeSnapshot,
  shapeStick,
  type GamepadAction,
  type GamepadInput,
} from '../index.js';

export interface Check {
  readonly name: string;
  readonly category: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface IsolationReport {
  readonly ok: boolean;
  readonly passed: number;
  readonly total: number;
  readonly failures: readonly string[];
  readonly checks: readonly Check[];
  readonly mapping: typeof STANDARD_GAMEPAD_MAPPING;
}

const DT = 1 / 60;
const EPS = 1e-9;

class Checks {
  readonly list: Check[] = [];

  ok(category: string, name: string, pass: boolean, detail: string): void {
    this.list.push({ category, name, pass, detail });
  }

  eq(category: string, name: string, actual: number, expected: number): void {
    const pass = Math.abs(actual - expected) <= EPS;
    this.ok(category, name, pass, `actual=${actual} expected=${expected}`);
  }

  is(category: string, name: string, actual: unknown, expected: unknown): void {
    this.ok(category, name, actual === expected, `actual=${String(actual)} expected=${String(expected)}`);
  }
}

/** Build a manager backed by scripted seams. */
function rig(): { manager: CoopInputManager; source: ScriptedGamepadSource; events: ManualEventTarget } {
  const source = new ScriptedGamepadSource();
  const events = new ManualEventTarget();
  const manager = new CoopInputManager({ source, events });
  return { manager, source, events };
}

/** Full-deflection move.x the library produces for a saturated stick axis. */
const FULL_MOVE_X = shapeStick(1, 0, DEFAULT_GAMEPAD_CONFIG.stickDeadzone, DEFAULT_GAMEPAD_CONFIG.stickOuterZone).x;

/**
 * The isolation predicate under test: two slots are isolated iff each reads its
 * OWN device's driven value and the two disagree. Returned as a boolean plus a
 * reason so the same predicate can drive both a positive check and a negative
 * control.
 */
function slotsIsolated(a: GamepadInput, b: GamepadInput, expectA: number, expectB: number): { isolated: boolean; reason: string } {
  const aMatches = Math.abs(a.move.x - expectA) <= EPS;
  const bMatches = Math.abs(b.move.x - expectB) <= EPS;
  const differ = Math.abs(a.move.x - b.move.x) > EPS;
  return {
    isolated: aMatches && bMatches && differ,
    reason: `a.move.x=${a.move.x} (want ${expectA}), b.move.x=${b.move.x} (want ${expectB}), differ=${differ}`,
  };
}

// ── Scenario: two-slot isolation, with negative controls ─────────────────────
function scenarioIsolation(c: Checks): void {
  const cat = 'isolation';
  const { manager, source } = rig();
  const a = manager.join('p1', 0);
  const b = manager.join('p2', 1);

  // Drive device 0 hard right, device 1 hard left — deliberately distinct.
  source.setSpec({ index: 0, axes: { 0: 1 } });
  source.setSpec({ index: 1, axes: { 0: -1 } });
  manager.sample(DT);

  const positive = slotsIsolated(a, b, FULL_MOVE_X, -FULL_MOVE_X);
  c.ok(cat, 'distinct-devices-do-not-bleed', positive.isolated, positive.reason);
  c.eq(cat, 'slotA-reads-device0', a.move.x, FULL_MOVE_X);
  c.eq(cat, 'slotB-reads-device1', b.move.x, -FULL_MOVE_X);

  // Hold jump on device 0 only.
  source.setSpec({ index: 0, buttons: { [BUTTON.jump]: true } });
  source.setSpec({ index: 1, axes: {} });
  manager.sample(DT);
  c.is(cat, 'jump-on-device0-only-A', a.jump, true);
  c.is(cat, 'jump-on-device0-only-B', b.jump, false);
  manager.dispose();

  // Negative control #1 — shared device MUST be identical. The isolation
  // predicate, asked to prove isolation between two slots on the SAME device,
  // must report NOT isolated. If it reported isolated here, every green check
  // above would be meaningless.
  {
    const ctl = rig();
    const ca = ctl.manager.join('p1', 0);
    const cb = ctl.manager.join('p2', 0); // same index on purpose
    ctl.source.setSpec({ index: 0, axes: { 0: 1 } });
    ctl.manager.sample(DT);
    const control = slotsIsolated(ca, cb, FULL_MOVE_X, -FULL_MOVE_X);
    c.ok(cat, 'NEG-shared-device-not-isolated', control.isolated === false, `predicate.isolated=${control.isolated} (${control.reason})`);
    c.eq(cat, 'NEG-shared-device-values-identical', ca.move.x - cb.move.x, 0);
    ctl.manager.dispose();
  }

  // Negative control #2 — cross-wired expectation MUST fail. Drive both devices
  // identically, then assert isolation against distinct expectations; the
  // predicate must catch that the two slots do NOT differ.
  {
    const ctl = rig();
    const ca = ctl.manager.join('p1', 0);
    const cb = ctl.manager.join('p2', 1);
    ctl.source.setSpec({ index: 0, axes: { 0: 1 } });
    ctl.source.setSpec({ index: 1, axes: { 0: 1 } }); // identical, not distinct
    ctl.manager.sample(DT);
    const control = slotsIsolated(ca, cb, FULL_MOVE_X, -FULL_MOVE_X);
    c.ok(cat, 'NEG-identical-input-not-isolated', control.isolated === false, `predicate.isolated=${control.isolated} (${control.reason})`);
    ctl.manager.dispose();
  }
}

// ── Scenario: connect establishes state without a phantom edge ───────────────
function scenarioConnect(c: Checks): void {
  const cat = 'connect';
  const { manager, source } = rig();
  const a = manager.join('p1', 0);

  c.is(cat, 'unconnected-before-first-sample', a.isConnected, false);

  // Connect with jump ALREADY held: the first sample must adopt the held state
  // but must NOT fire a press edge (the player did not press it in-game).
  source.setSpec({ index: 0, buttons: { [BUTTON.jump]: true } });
  manager.sample(DT);
  c.is(cat, 'connected-after-first-sample', a.isConnected, true);
  c.is(cat, 'held-adopted-on-connect', a.jump, true);
  c.is(cat, 'no-phantom-edge-on-connect', a.pressed('jump'), false);
  manager.dispose();
}

// ── Scenario: disconnect while held releases ALL state ───────────────────────
function scenarioDisconnectWhileHeld(c: Checks): void {
  const cat = 'disconnect';
  const { manager, source, events } = rig();
  const a = manager.join('p1', 0);
  const b = manager.join('p2', 1);

  // Establish, then hold jump + fire + full move on device 0.
  source.setSpec({ index: 0 });
  source.setSpec({ index: 1 });
  manager.sample(DT);
  source.setSpec({ index: 0, axes: { 0: 1, 1: -1 }, buttons: { [BUTTON.jump]: true, [BUTTON.fire]: true } });
  source.setSpec({ index: 1, axes: { 0: -1 } });
  manager.sample(DT);
  c.is(cat, 'held-before-disconnect-jump', a.jump, true);
  c.is(cat, 'held-before-disconnect-fire', a.fire, true);
  c.ok(cat, 'moving-before-disconnect', Math.abs(a.move.x) > 0 && Math.abs(a.move.y) > 0, `move=${a.move.x},${a.move.y}`);

  // Poll-detected disconnect: the device vanishes from the source.
  source.remove(0);
  manager.sample(DT);
  c.is(cat, 'jump-released-on-disconnect', a.jump, false);
  c.is(cat, 'fire-released-on-disconnect', a.fire, false);
  c.eq(cat, 'move-x-zeroed-on-disconnect', a.move.x, 0);
  c.eq(cat, 'move-y-zeroed-on-disconnect', a.move.y, 0);
  c.eq(cat, 'look-x-zeroed-on-disconnect', a.look.x, 0);
  c.is(cat, 'disconnected-flag', a.isConnected, false);
  // Isolation under fault: slot B kept its own input across A's disconnect.
  c.eq(cat, 'peer-unaffected-by-disconnect', b.move.x, -FULL_MOVE_X);

  // Event-driven disconnect releases IMMEDIATELY, before the next poll.
  const src2 = new ScriptedGamepadSource();
  const ev2 = new ManualEventTarget();
  const m2 = new CoopInputManager({ source: src2, events: ev2 });
  const a2 = m2.join('p1', 3);
  src2.setSpec({ index: 3 });
  m2.sample(DT);
  src2.setSpec({ index: 3, buttons: { [BUTTON.jump]: true } });
  m2.sample(DT);
  c.is(cat, 'held-before-event-disconnect', a2.jump, true);
  ev2.dispatch('gamepaddisconnected', { gamepad: { index: 3, id: 'x' } });
  c.is(cat, 'released-on-disconnect-event-without-poll', a2.jump, false);
  m2.dispose();

  void events;
  manager.dispose();
}

// ── Scenario: focus loss suspends and holds neutral until focus returns ──────
function scenarioFocusLoss(c: Checks): void {
  const cat = 'focus';
  const { manager, source, events } = rig();
  const a = manager.join('p1', 0);

  source.setSpec({ index: 0 });
  manager.sample(DT);
  source.setSpec({ index: 0, axes: { 0: 1 }, buttons: { [BUTTON.fire]: true } });
  manager.sample(DT);
  c.is(cat, 'firing-before-blur', a.fire, true);

  events.dispatch('blur');
  c.is(cat, 'suspended-after-blur', a.isSuspended, true);
  c.is(cat, 'fire-released-after-blur', a.fire, false);
  c.eq(cat, 'move-zeroed-after-blur', a.move.x, 0);

  // While blurred, the device is STILL driven hard, yet sampling stays neutral.
  manager.sample(DT);
  c.eq(cat, 'sampling-stays-neutral-while-blurred', a.move.x, 0);
  c.is(cat, 'fire-stays-released-while-blurred', a.fire, false);

  events.dispatch('focus');
  c.is(cat, 'not-suspended-after-focus', a.isSuspended, false);
  manager.sample(DT);
  c.eq(cat, 'input-restored-after-focus', a.move.x, FULL_MOVE_X);
  manager.dispose();
}

// ── Scenario: BFCache-safe suspend / resume / dispose ────────────────────────
function scenarioBFCache(c: Checks): void {
  const cat = 'bfcache';
  const { manager, source, events } = rig();
  const a = manager.join('p1', 0);
  source.setSpec({ index: 0, axes: { 0: 1 } });
  manager.sample(DT);
  c.eq(cat, 'moving-before-pagehide', a.move.x, FULL_MOVE_X);

  events.dispatch('pagehide', { persisted: true });
  c.is(cat, 'suspended-on-pagehide', a.isSuspended, true);
  c.eq(cat, 'neutral-on-pagehide', a.move.x, 0);

  // A non-persisted pageshow (fresh load) must NOT resume a BFCached page.
  events.dispatch('pageshow', { persisted: false });
  c.is(cat, 'still-suspended-after-nonpersisted-pageshow', a.isSuspended, true);

  // A persisted pageshow (restore FROM BFCache) resumes.
  events.dispatch('pageshow', { persisted: true });
  c.is(cat, 'resumed-after-persisted-pageshow', a.isSuspended, false);
  manager.sample(DT);
  c.eq(cat, 'input-restored-after-restore', a.move.x, FULL_MOVE_X);

  // Dispose removes every listener — no leak across a real navigation.
  const before = events.listenerCount();
  manager.dispose();
  c.ok(cat, 'listeners-present-before-dispose', before > 0, `count=${before}`);
  c.is(cat, 'listeners-removed-after-dispose', events.listenerCount(), 0);
  c.is(cat, 'manager-disposed-flag', manager.isDisposed, true);
  manager.dispose(); // idempotent
  c.is(cat, 'dispose-idempotent', events.listenerCount(), 0);
}

// ── Scenario: rejoin (re-join a slot id, and reconnect a device) ─────────────
function scenarioRejoin(c: Checks): void {
  const cat = 'rejoin';
  const { manager, source } = rig();
  const a = manager.join('p1', 0);
  source.setSpec({ index: 0, axes: { 0: 1 }, buttons: { [BUTTON.jump]: true } });
  manager.sample(DT);
  c.is(cat, 'held-before-leave', a.jump, true);

  // Leave then re-join the SAME slot id: the new slot is a clean instance.
  manager.leave('p1');
  c.is(cat, 'slot-gone-after-leave', manager.has('p1'), false);
  c.is(cat, 'left-slot-disposed', a.isDisposed, true);
  const a2 = manager.join('p1', 0);
  c.is(cat, 'rejoined-instance-is-fresh', a2 === a, false);
  c.is(cat, 'rejoined-instance-starts-neutral', a2.jump, false);

  // Device reconnect on the same index: disconnect, then bring it back.
  source.setSpec({ index: 0 });
  manager.sample(DT);
  source.remove(0);
  manager.sample(DT);
  c.is(cat, 'disconnected-after-remove', a2.isConnected, false);
  source.setSpec({ index: 0, buttons: { [BUTTON.jump]: true } });
  manager.sample(DT);
  c.is(cat, 'reconnected-adopts-state', a2.jump, true);
  c.is(cat, 'reconnect-no-phantom-edge', a2.pressed('jump'), false);
  manager.dispose();
}

// ── Scenario: axis NaN refused, out-of-range clamped, isolation under fault ──
function scenarioAxisValidation(c: Checks): void {
  const cat = 'axis';
  const { manager, source } = rig();
  const a = manager.join('p1', 0);
  const b = manager.join('p2', 1);

  // Valid B, NaN-axis A: sample() must throw, carrying a typed fault for A, and
  // B must sample cleanly — a malformed pad in one slot cannot rob its peer.
  source.set(0, makeSnapshot({ index: 0, axes: { 0: Number.NaN } }));
  source.setSpec({ index: 1, axes: { 0: -1 } });

  const report = manager.pollSlots(DT);
  const fault = report.faults.find((f) => f.slotId === 'p1');
  c.ok(cat, 'nan-axis-produces-fault', fault !== undefined, `faults=${report.faults.length}`);
  c.ok(cat, 'nan-axis-fault-is-typed', fault?.error instanceof NonFiniteAxisError, `type=${fault?.error?.constructor.name}`);
  c.is(cat, 'nan-axis-fault-names-axis', (fault?.error as NonFiniteAxisError | undefined)?.axisIndex, 0);
  c.eq(cat, 'nan-slot-released', a.move.x, 0);
  c.is(cat, 'nan-slot-not-connected', a.isConnected, false);
  c.eq(cat, 'peer-clean-under-nan-fault', b.move.x, -FULL_MOVE_X);

  // The loud path: sample() aggregates the same fault.
  let threw: unknown;
  try {
    manager.sample(DT);
  } catch (error) {
    threw = error;
  }
  c.ok(cat, 'sample-throws-aggregate', threw instanceof AggregateError, `type=${(threw as Error)?.constructor?.name}`);
  c.ok(cat, 'aggregate-carries-typed-error', threw instanceof AggregateError && threw.errors.some((e) => e instanceof NonFiniteAxisError), 'errors');

  // Out-of-range but finite is CLAMPED, not refused.
  source.setSpec({ index: 0, axes: { 0: 5 } });
  source.setSpec({ index: 1, axes: { 0: -9 } });
  const clean = manager.pollSlots(DT);
  c.is(cat, 'out-of-range-not-faulted', clean.faults.length, 0);
  c.eq(cat, 'positive-out-of-range-clamped-to-1', a.move.x, FULL_MOVE_X);
  c.eq(cat, 'negative-out-of-range-clamped-to-minus1', b.move.x, -FULL_MOVE_X);
  manager.dispose();
}

// ── Scenario: malformed structure and non-standard mapping refused ───────────
function scenarioMalformed(c: Checks): void {
  const cat = 'malformed';
  const { manager, source } = rig();
  const a = manager.join('p1', 0);

  // Too few axes.
  source.set(0, makeSnapshot({ index: 0, axisCount: 2 }));
  let faults = manager.pollSlots(DT).faults;
  c.ok(cat, 'truncated-axes-faults', faults[0]?.error instanceof MalformedGamepadError, `type=${faults[0]?.error?.constructor.name}`);
  c.is(cat, 'truncated-axes-field', (faults[0]?.error as MalformedGamepadError | undefined)?.field, 'axes');

  // Too few buttons.
  source.set(0, makeSnapshot({ index: 0, buttonCount: 3 }));
  faults = manager.pollSlots(DT).faults;
  c.ok(cat, 'truncated-buttons-faults', faults[0]?.error instanceof MalformedGamepadError, `type=${faults[0]?.error?.constructor.name}`);
  c.is(cat, 'truncated-buttons-field', (faults[0]?.error as MalformedGamepadError | undefined)?.field, 'buttons');

  // Non-standard mapping refused by default.
  source.set(0, makeSnapshot({ index: 0, mapping: '' }));
  faults = manager.pollSlots(DT).faults;
  c.ok(cat, 'nonstandard-mapping-faults', faults[0]?.error instanceof UnsupportedMappingError, `type=${faults[0]?.error?.constructor.name}`);
  c.eq(cat, 'malformed-slot-stays-released', a.move.x, 0);
  manager.dispose();

  // Opt-in: a host may relax the mapping requirement.
  const relaxed = new CoopInputManager({
    source: new ScriptedGamepadSource().setSpec({ index: 0, mapping: '', axes: { 0: 1 } }),
    events: null,
    config: { requireStandardMapping: false },
  });
  const ra = relaxed.join('p1', 0);
  const relaxedFaults = relaxed.pollSlots(DT).faults;
  c.is(cat, 'relaxed-mapping-accepted', relaxedFaults.length, 0);
  c.eq(cat, 'relaxed-mapping-reads-axis', ra.move.x, FULL_MOVE_X);
  relaxed.dispose();
}

// ── Scenario: exact button mapping, per action, in isolation ─────────────────
function scenarioButtonMapping(c: Checks): void {
  const cat = 'mapping';
  for (const action of GAMEPAD_ACTIONS) {
    const { manager, source } = rig();
    const a = manager.join('p1', 0);
    source.setSpec({ index: 0 });
    manager.sample(DT); // establish neutral (consume connect resync)
    source.setSpec({ index: 0, buttons: { [ACTION_BUTTON[action]]: true } });
    manager.sample(DT);

    c.is(cat, `${action}-button-${ACTION_BUTTON[action]}-drives-${action}`, readAction(a, action), true);
    c.is(cat, `${action}-edge-on-press`, a.pressed(action), true);

    // Every OTHER action must be untouched by this button.
    let othersClean = true;
    for (const other of GAMEPAD_ACTIONS) {
      if (other === action) continue;
      if (readAction(a, other) || a.pressed(other)) othersClean = false;
    }
    c.ok(cat, `${action}-does-not-trip-others`, othersClean, 'only the mapped action responded');

    // Holding does not re-fire the edge next frame.
    manager.sample(DT);
    c.is(cat, `${action}-edge-clears-while-held`, a.pressed(action), false);
    c.is(cat, `${action}-still-held`, readAction(a, action), true);
    manager.dispose();
  }

  // Analog trigger threshold: value alone (no digital press) drives fire/aim.
  const { manager, source } = rig();
  const a = manager.join('p1', 0);
  source.setSpec({ index: 0 });
  manager.sample(DT);
  source.setSpec({ index: 0, buttons: { [BUTTON.fire]: { pressed: false, value: 0.6 } } });
  manager.sample(DT);
  c.is('mapping', 'trigger-value-over-threshold-fires', a.fire, true);
  source.setSpec({ index: 0, buttons: { [BUTTON.fire]: { pressed: false, value: 0.4 } } });
  manager.sample(DT);
  c.is('mapping', 'trigger-value-under-threshold-idle', a.fire, false);
  manager.dispose();
}

// ── Scenario: deadzone and normalisation, with a negative control ────────────
function scenarioDeadzone(c: Checks): void {
  const cat = 'deadzone';
  const { manager, source } = rig();
  const a = manager.join('p1', 0);

  // Inside the deadzone reads as centred...
  const inside = DEFAULT_GAMEPAD_CONFIG.stickDeadzone * 0.5;
  source.setSpec({ index: 0, axes: { 0: inside, 1: inside } });
  manager.sample(DT);
  c.eq(cat, 'inside-deadzone-x-zero', a.move.x, 0);
  c.eq(cat, 'inside-deadzone-y-zero', a.move.y, 0);

  // ...just outside it does not. NEGATIVE CONTROL for the deadzone: if the
  // deadzone did nothing, the value above would be non-zero too, so a live
  // reading here proves the filter is real, not that everything reads zero.
  const outside = DEFAULT_GAMEPAD_CONFIG.stickDeadzone + 0.2;
  source.setSpec({ index: 0, axes: { 0: outside } });
  manager.sample(DT);
  c.ok(cat, 'NEG-outside-deadzone-nonzero', Math.abs(a.move.x) > EPS, `move.x=${a.move.x}`);

  // Diagonal is normalised: magnitude never exceeds 1.
  source.setSpec({ index: 0, axes: { 0: 1, 1: 1 } });
  manager.sample(DT);
  const mag = Math.hypot(a.move.x, a.move.y);
  c.ok(cat, 'diagonal-magnitude-le-1', mag <= 1 + EPS, `|move|=${mag}`);
  manager.dispose();
}

// ── Scenario: frame-rate-independent look ────────────────────────────────────
function scenarioLook(c: Checks): void {
  const cat = 'look';
  const { manager, source } = rig();
  const a = manager.join('p1', 0);
  source.setSpec({ index: 0 });
  manager.sample(DT);

  // Right stick hard right; accumulate look as the consumer would (yaw -= look.x).
  source.setSpec({ index: 0, axes: { 2: 1 } });

  // One big step vs. two half-steps over equal wall-clock must rotate equally.
  manager.sample(0.1);
  const yawOneStep = a.look.x;

  manager.sample(0.05);
  let yawTwoSteps = a.look.x;
  manager.sample(0.05);
  yawTwoSteps += a.look.x;
  c.ok(cat, 'look-is-frame-rate-independent', Math.abs(yawOneStep - yawTwoSteps) <= 1e-9, `1x0.1=${yawOneStep} 2x0.05=${yawTwoSteps}`);

  // dt is clamped so a stalled tab cannot snap the camera.
  manager.sample(10);
  const yawHuge = a.look.x;
  manager.sample(DEFAULT_GAMEPAD_CONFIG.maxTimeStepSeconds);
  const yawClamp = a.look.x;
  c.ok(cat, 'huge-dt-clamped-to-max', Math.abs(yawHuge - yawClamp) <= 1e-9, `huge=${yawHuge} clamped=${yawClamp}`);

  // Right stick maps to look, NOT to move; the left stick is centred here.
  c.eq(cat, 'right-stick-does-not-move', a.move.x, 0);

  // Vertical: non-inverted default means stick-up (negative Y) looks up
  // (positive pitch delta after the consumer's `pitch - look.y`).
  source.setSpec({ index: 0, axes: { 3: -1 } });
  manager.sample(DT);
  c.ok(cat, 'stick-up-looks-up-default', a.look.y < 0, `look.y=${a.look.y}`);
  manager.dispose();
}

function readAction(slot: GamepadInput, action: GamepadAction): boolean {
  switch (action) {
    case 'jump': return slot.jump;
    case 'crouch': return slot.crouch;
    case 'sprint': return slot.sprint;
    case 'fire': return slot.fire;
    case 'aim': return slot.aim;
    case 'reload': return slot.reload;
  }
}

export function runIsolationSuite(): IsolationReport {
  const c = new Checks();
  scenarioIsolation(c);
  scenarioConnect(c);
  scenarioDisconnectWhileHeld(c);
  scenarioFocusLoss(c);
  scenarioBFCache(c);
  scenarioRejoin(c);
  scenarioAxisValidation(c);
  scenarioMalformed(c);
  scenarioButtonMapping(c);
  scenarioDeadzone(c);
  scenarioLook(c);

  const checks = c.list;
  const failures = checks.filter((x) => !x.pass).map((x) => `[${x.category}] ${x.name}: ${x.detail}`);
  return {
    ok: failures.length === 0,
    passed: checks.length - failures.length,
    total: checks.length,
    failures,
    checks,
    mapping: STANDARD_GAMEPAD_MAPPING,
  };
}
