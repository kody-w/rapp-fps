/**
 * Deterministic, headless implementations of the input seams.
 *
 * These are the doubles a Node fixture wires in place of the browser: a
 * `ScriptedGamepadSource` whose per-index devices are set by the test, and a
 * `ManualEventTarget` whose events are dispatched by the test. They ship as part
 * of the library (not buried in a test folder) because deterministic control of
 * the seams is a first-class capability — the same doubles drive the isolation
 * proof, and a host could use them to record and replay real input.
 *
 * `ScriptedGamepadSource` is deliberately per-index: setting device 0 cannot
 * touch device 1. That isolation is a property of THIS class, and the fixture
 * leans on it to make a clean claim — any bleed it observes is in the library
 * under test, not in the test rig.
 */

import type { EventTargetLike, GamepadSource } from './seams.js';
import type { GamepadButtonSnapshot, GamepadSnapshot } from './types.js';
import { REQUIRED_AXIS_COUNT, REQUIRED_BUTTON_COUNT, STANDARD_MAPPING } from './mapping.js';

/** Options for the convenience builder `makeSnapshot`. */
export interface SnapshotSpec {
  readonly index: number;
  readonly id?: string;
  readonly connected?: boolean;
  readonly mapping?: string;
  /** Sparse axis overrides by index; unspecified axes read 0. */
  readonly axes?: Readonly<Record<number, number>>;
  /** Sparse button overrides by index; unspecified buttons read released. */
  readonly buttons?: Readonly<Record<number, number | boolean | GamepadButtonSnapshot>>;
  readonly timestamp?: number;
  /** Total axis count to report (defaults to the standard requirement). */
  readonly axisCount?: number;
  /** Total button count to report (defaults to the standard requirement). */
  readonly buttonCount?: number;
}

/**
 * Build a fully-formed, standard-shaped snapshot from a sparse spec. Everything
 * unspecified defaults to a neutral, connected, standard device, so a test only
 * states the axes and buttons it cares about.
 */
export function makeSnapshot(spec: SnapshotSpec): GamepadSnapshot {
  const axisCount = spec.axisCount ?? REQUIRED_AXIS_COUNT;
  const buttonCount = spec.buttonCount ?? REQUIRED_BUTTON_COUNT;

  const axes: number[] = [];
  for (let i = 0; i < axisCount; i++) axes.push(spec.axes?.[i] ?? 0);

  const buttons: GamepadButtonSnapshot[] = [];
  for (let i = 0; i < buttonCount; i++) buttons.push(normaliseButton(spec.buttons?.[i]));

  return {
    index: spec.index,
    id: spec.id ?? `scripted-pad-${spec.index}`,
    connected: spec.connected ?? true,
    mapping: spec.mapping ?? STANDARD_MAPPING,
    axes,
    buttons,
    timestamp: spec.timestamp ?? 0,
  };
}

function normaliseButton(
  raw: number | boolean | GamepadButtonSnapshot | undefined,
): GamepadButtonSnapshot {
  if (raw === undefined) return { pressed: false, value: 0 };
  if (typeof raw === 'boolean') return { pressed: raw, value: raw ? 1 : 0 };
  if (typeof raw === 'number') return { pressed: raw >= 0.5, value: raw };
  return { pressed: raw.pressed, value: raw.value };
}

/**
 * A `GamepadSource` whose devices are set explicitly, per hardware index.
 *
 * The internal map is keyed by index, and `poll` reads only the requested key,
 * so there is structurally no path by which setting one index affects the read
 * of another. A test can also override `poll` behaviour indirectly by setting a
 * device to `null` (absent) or a disconnected snapshot.
 */
export class ScriptedGamepadSource implements GamepadSource {
  private readonly devices = new Map<number, GamepadSnapshot>();
  private pollCount = 0;

  /** Place (or replace) the device at an index. */
  set(index: number, snapshot: GamepadSnapshot): this {
    this.devices.set(index, snapshot);
    return this;
  }

  /** Convenience: build and place a device from a sparse spec at `spec.index`. */
  setSpec(spec: SnapshotSpec): this {
    return this.set(spec.index, makeSnapshot(spec));
  }

  /** Remove the device at an index entirely, so `poll(index)` returns null. */
  remove(index: number): this {
    this.devices.delete(index);
    return this;
  }

  /** Mark the device at an index disconnected without removing its slot entry. */
  disconnect(index: number): this {
    const existing = this.devices.get(index);
    if (existing) this.devices.set(index, { ...existing, connected: false });
    return this;
  }

  /** How many times `poll` has been called, for asserting a source is untouched. */
  get polls(): number {
    return this.pollCount;
  }

  poll(index: number): GamepadSnapshot | null {
    this.pollCount++;
    return this.devices.get(index) ?? null;
  }
}

/** One recorded listener registration, so the test can assert clean teardown. */
interface Registration {
  readonly type: string;
  readonly listener: (event: unknown) => void;
}

/**
 * An `EventTargetLike` that records its listeners and dispatches on command.
 *
 * It exposes `dispatch(type, event)` so a fixture can simulate `blur`,
 * `pagehide`, `gamepaddisconnected` and friends deterministically, and
 * `listenerCount()` so the fixture can prove `dispose()` removed every handler
 * (a leaked listener across BFCache restores is exactly the bug this guards).
 */
export class ManualEventTarget implements EventTargetLike {
  private readonly registrations: Registration[] = [];

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.registrations.push({ type, listener });
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const at = this.registrations.findIndex(
      (r) => r.type === type && r.listener === listener,
    );
    if (at >= 0) this.registrations.splice(at, 1);
  }

  /** Fire every listener currently registered for `type`. */
  dispatch(type: string, event: unknown = {}): void {
    for (const r of this.registrations.slice()) {
      if (r.type === type) r.listener(event);
    }
  }

  /** Total live listeners, or those for one type. Zero after a clean dispose. */
  listenerCount(type?: string): number {
    if (type === undefined) return this.registrations.length;
    return this.registrations.filter((r) => r.type === type).length;
  }
}
