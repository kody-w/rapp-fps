/**
 * The multi-slot coordinator: assigns player slots to gamepad indices and owns
 * their shared lifecycle.
 *
 * A host `join`s a slot to a device index, then calls `manager.sample(dt)` once
 * per frame; each slot polls its OWN device and updates its own `InputState`.
 * The manager adds three things a lone slot cannot:
 *
 *   1. explicit slot bookkeeping (`join`/`leave`, duplicate/unknown-slot errors),
 *   2. fault isolation across a frame — one malformed device throws AFTER every
 *      other slot has already sampled, so a broken pad in slot B never robs
 *      slot A of a frame of input, and
 *   3. browser lifecycle wiring through the injected event seam — focus loss,
 *      BFCache page-hide/show, and gamepad connect/disconnect — each of which
 *      releases held state so nothing sticks across a suspend or a yanked cable.
 *
 * Every browser touch is behind the `GamepadSource` and `EventTargetLike` seams,
 * so the whole thing runs headless in a Node fixture with scripted doubles.
 */

import type { InputState } from '../../core/contracts.js';
import type { EventTargetLike, GamepadSource } from './seams.js';
import { browserEventTarget, browserGamepadSource } from './seams.js';
import type { GamepadConfig } from './config.js';
import { resolveConfig } from './config.js';
import { GamepadInput } from './GamepadInput.js';
import { DisposedError, DuplicateSlotError, InvalidTimeStepError, UnknownSlotError } from './errors.js';
import type { PlayerSlotId } from './types.js';

/** One slot's failure during a frame, paired with the slot it came from. */
export interface SlotFault {
  readonly slotId: PlayerSlotId;
  readonly error: Error;
}

/** Result of a non-throwing frame poll. */
export interface SampleReport {
  /** Empty when every joined slot sampled cleanly. */
  readonly faults: readonly SlotFault[];
}

export interface CoopInputManagerOptions {
  /**
   * Where device snapshots come from. Defaults to the live browser source;
   * inject a `ScriptedGamepadSource` for headless/deterministic use. Not
   * resolved until construction, so a Node caller MUST inject one (the default
   * throws clearly if `navigator.getGamepads` is missing).
   */
  readonly source?: GamepadSource;
  /**
   * Lifecycle event source. `undefined` wires the real `window`; pass an
   * injected target (e.g. `ManualEventTarget`) for tests, or `null` to opt out
   * of automatic lifecycle handling entirely and drive `suspendAll`/`resumeAll`
   * by hand.
   */
  readonly events?: EventTargetLike | null;
  /** Tuning overrides applied to every slot this manager creates. */
  readonly config?: Partial<GamepadConfig>;
  /** Notified when the browser reports a device connected at `index`. */
  readonly onDeviceConnected?: (index: number, id: string) => void;
  /** Notified when the browser reports a device disconnected at `index`. */
  readonly onDeviceDisconnected?: (index: number, id: string) => void;
}

/** The minimal shape of a `GamepadEvent` we read off the event seam. */
interface GamepadEventLike {
  readonly gamepad: { readonly index: number; readonly id: string };
}

/** The minimal shape of a `PageTransitionEvent` we read off the event seam. */
interface PageTransitionEventLike {
  readonly persisted: boolean;
}

export class CoopInputManager {
  private readonly source: GamepadSource;
  private readonly events: EventTargetLike | null;
  private readonly config: GamepadConfig;
  private readonly onDeviceConnected?: (index: number, id: string) => void;
  private readonly onDeviceDisconnected?: (index: number, id: string) => void;

  private readonly slotsById = new Map<PlayerSlotId, GamepadInput>();
  private suspended = false;
  private disposed = false;

  constructor(options: CoopInputManagerOptions = {}) {
    this.source = options.source ?? browserGamepadSource();
    this.events = options.events === undefined ? browserEventTarget() : options.events;
    this.config = resolveConfig(options.config);
    this.onDeviceConnected = options.onDeviceConnected;
    this.onDeviceDisconnected = options.onDeviceDisconnected;
    this.wireEvents();
  }

  /** How many slots are currently joined. */
  get size(): number {
    return this.slotsById.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** True while suspended by focus loss or BFCache; slots yield neutral state. */
  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Bind a player slot to a hardware device index and return its `InputState`.
   *
   * Throws `DuplicateSlotError` if the slot id is taken and
   * `InvalidDeviceIndexError` if the index is not a non-negative integer. Two
   * slots MAY share a device index — that is a valid (if unusual) configuration
   * and the isolation fixture's negative control depends on it — but each slot
   * id is unique.
   */
  join(slotId: PlayerSlotId, deviceIndex: number): GamepadInput {
    this.assertLive();
    if (this.slotsById.has(slotId)) throw new DuplicateSlotError(slotId);
    const slot = new GamepadInput(slotId, deviceIndex, this.source, this.config);
    if (this.suspended) slot.suspend();
    this.slotsById.set(slotId, slot);
    return slot;
  }

  /** Remove and dispose a slot. Throws `UnknownSlotError` if it is not joined. */
  leave(slotId: PlayerSlotId): void {
    this.assertLive();
    const slot = this.slotsById.get(slotId);
    if (!slot) throw new UnknownSlotError(slotId);
    slot.dispose();
    this.slotsById.delete(slotId);
  }

  /** True if the slot id is currently joined. */
  has(slotId: PlayerSlotId): boolean {
    return this.slotsById.has(slotId);
  }

  /** Get a joined slot's input. Throws `UnknownSlotError` if it is not joined. */
  slot(slotId: PlayerSlotId): GamepadInput {
    const slot = this.slotsById.get(slotId);
    if (!slot) throw new UnknownSlotError(slotId);
    return slot;
  }

  /** Get a joined slot's input, or `undefined` if it is not joined. */
  tryGet(slotId: PlayerSlotId): GamepadInput | undefined {
    return this.slotsById.get(slotId);
  }

  /** Iterate `[slotId, input]` pairs for every joined slot. */
  slots(): IterableIterator<[PlayerSlotId, GamepadInput]> {
    return this.slotsById.entries();
  }

  /** The joined slots' inputs, in join order, typed as the engine contract. */
  inputs(): InputState[] {
    return [...this.slotsById.values()];
  }

  /**
   * Sample every joined slot for one frame, LOUDLY.
   *
   * Every slot is sampled even if an earlier one faulted, so isolation holds;
   * then, if any slot threw, an `AggregateError` carrying the per-slot typed
   * errors is raised. A host that would rather keep running should call
   * `pollSlots` instead and inspect the returned faults.
   */
  sample(dt: number): void {
    const faults = this.sampleEach(dt);
    if (faults.length > 0) {
      throw new AggregateError(
        faults.map((f) => f.error),
        `${faults.length} slot(s) faulted during sample: `
          + faults.map((f) => String(f.slotId)).join(', '),
      );
    }
  }

  /**
   * Sample every joined slot for one frame, returning any faults instead of
   * throwing them. `dt` is still validated once up front (a bad timestep is a
   * caller bug, not a device fault) and throws `InvalidTimeStepError`.
   */
  pollSlots(dt: number): SampleReport {
    return { faults: this.sampleEach(dt) };
  }

  /** Release all held state on every slot and hold neutral until `resumeAll`. */
  suspendAll(): void {
    if (this.disposed) return;
    this.suspended = true;
    for (const slot of this.slotsById.values()) slot.suspend();
  }

  /** Resume sampling on every slot after `suspendAll`. */
  resumeAll(): void {
    if (this.disposed) return;
    this.suspended = false;
    for (const slot of this.slotsById.values()) slot.resume();
  }

  /** Detach every slot and remove all lifecycle listeners. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwireEvents();
    for (const slot of this.slotsById.values()) slot.dispose();
    this.slotsById.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private sampleEach(dt: number): SlotFault[] {
    this.assertLive();
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) {
      throw new InvalidTimeStepError(dt);
    }
    const faults: SlotFault[] = [];
    for (const slot of this.slotsById.values()) {
      try {
        slot.sample(dt);
      } catch (error) {
        faults.push({ slotId: slot.slotId, error: error as Error });
      }
    }
    return faults;
  }

  private handleDeviceConnected(index: number, id: string): void {
    // Slots pick the device up on their next poll; this is purely a host hook,
    // e.g. to auto-join a newly plugged controller.
    this.onDeviceConnected?.(index, id);
  }

  private handleDeviceDisconnected(index: number, id: string): void {
    // Release any slot on that index NOW rather than waiting for the next poll,
    // so a yanked cable cannot leave an action held for a frame.
    for (const slot of this.slotsById.values()) {
      if (slot.deviceIndex === index) slot.release();
    }
    this.onDeviceDisconnected?.(index, id);
  }

  private assertLive(): void {
    if (this.disposed) throw new DisposedError('CoopInputManager');
  }

  // ── Event seam wiring ──────────────────────────────────────────────────────

  private readonly onBlur = (): void => this.suspendAll();
  private readonly onFocus = (): void => this.resumeAll();

  private readonly onPageHide = (): void => {
    // Entering the BFCache (or navigating away): release held state so a
    // restored page never resumes with a phantom-held button.
    this.suspendAll();
  };

  private readonly onPageShow = (event: unknown): void => {
    // Only a restore FROM the BFCache needs a resume; a fresh load has no
    // suspended state to lift.
    if (isPersisted(event)) this.resumeAll();
  };

  private readonly onGamepadConnected = (event: unknown): void => {
    const pad = gamepadOf(event);
    if (pad) this.handleDeviceConnected(pad.index, pad.id);
  };

  private readonly onGamepadDisconnected = (event: unknown): void => {
    const pad = gamepadOf(event);
    if (pad) this.handleDeviceDisconnected(pad.index, pad.id);
  };

  private wireEvents(): void {
    const target = this.events;
    if (!target) return;
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('focus', this.onFocus);
    target.addEventListener('pagehide', this.onPageHide);
    target.addEventListener('pageshow', this.onPageShow);
    target.addEventListener('gamepadconnected', this.onGamepadConnected);
    target.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
  }

  private unwireEvents(): void {
    const target = this.events;
    if (!target) return;
    target.removeEventListener('blur', this.onBlur);
    target.removeEventListener('focus', this.onFocus);
    target.removeEventListener('pagehide', this.onPageHide);
    target.removeEventListener('pageshow', this.onPageShow);
    target.removeEventListener('gamepadconnected', this.onGamepadConnected);
    target.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
  }
}

function isPersisted(event: unknown): boolean {
  return (
    typeof event === 'object'
    && event !== null
    && (event as Partial<PageTransitionEventLike>).persisted === true
  );
}

function gamepadOf(event: unknown): { index: number; id: string } | null {
  if (typeof event !== 'object' || event === null) return null;
  const pad = (event as Partial<GamepadEventLike>).gamepad;
  if (!pad || typeof pad.index !== 'number') return null;
  return { index: pad.index, id: typeof pad.id === 'string' ? pad.id : '' };
}
