/**
 * One player slot's view of one gamepad, presented as the engine's `InputState`.
 *
 * A `GamepadInput` is bound at construction to a single hardware device index
 * and a single `GamepadSource`, and it only ever polls THAT index. There is no
 * shared mutable state between two `GamepadInput` instances, which is the
 * structural reason two device indices cannot bleed into one another — the
 * isolation fixture proves the behaviour, but the guarantee lives here: slot A's
 * `sample` reads `source.poll(indexA)` and nothing of slot B's.
 *
 * Responsibilities per frame (`sample(dt)`):
 *   - poll the bound device through the injected seam,
 *   - refuse a malformed device LOUDLY (typed error) after releasing all state,
 *     so a garbage frame never sticks a button or corrupts aim silently,
 *   - shape the left stick into deadzoned, normalised `move`,
 *   - integrate the right stick into a frame-rate-independent `look` delta,
 *   - map the six action buttons to held booleans, and
 *   - raise edge-triggered `pressed()` for buttons that went down this frame.
 *
 * Lifecycle transitions (`suspend`/`resume`/`dispose`, plus connect/disconnect
 * detected during `sample`) all funnel through `releaseAll`, so losing focus,
 * losing the device, or entering the BFCache can never leave a held action set.
 */

import type { InputState } from '../../core/contracts.js';
import type { GamepadSource } from './seams.js';
import type { GamepadButtonSnapshot, GamepadSnapshot, PlayerSlotId } from './types.js';
import type { GamepadConfig } from './config.js';
import { clamp, lookDelta, shapeStick } from './config.js';
import {
  ACTION_BUTTON,
  AXIS,
  GAMEPAD_ACTIONS,
  REQUIRED_AXIS_COUNT,
  REQUIRED_BUTTON_COUNT,
  STANDARD_MAPPING,
  TRIGGER_ACTIONS,
} from './mapping.js';
import {
  DisposedError,
  InvalidDeviceIndexError,
  InvalidTimeStepError,
  MalformedGamepadError,
  NonFiniteAxisError,
  NonFiniteButtonError,
  UnsupportedMappingError,
} from './errors.js';
import type { GamepadAction } from './types.js';

/** A device snapshot after validation: finite, clamped, mapped indices present. */
interface ParsedSnapshot {
  readonly leftX: number;
  readonly leftY: number;
  readonly rightX: number;
  readonly rightY: number;
  readonly buttons: readonly GamepadButtonSnapshot[];
}

export class GamepadInput implements InputState {
  /** -1..1 per axis, deadzoned and normalised; magnitude never exceeds 1. */
  readonly move = { x: 0, y: 0 };
  /** Per-frame look delta in radians, already frame-rate-scaled by dt. */
  readonly look = { x: 0, y: 0 };

  jump = false;
  crouch = false;
  sprint = false;
  fire = false;
  aim = false;
  reload = false;

  readonly slotId: PlayerSlotId;
  readonly deviceIndex: number;

  private readonly source: GamepadSource;
  private readonly config: GamepadConfig;

  /** Actions held after the most recent sample. */
  private held = new Set<GamepadAction>();
  /** Actions held after the PREVIOUS sample, for edge detection. */
  private prevHeld = new Set<GamepadAction>();
  /** Actions that went down this frame; what `pressed()` reports. */
  private edges = new Set<string>();
  /** Imperative `press()` injections awaiting the next sample. */
  private injectedEdges = new Set<string>();

  private connected = false;
  private suspended = false;
  private disposed = false;
  /**
   * When true, the next sample establishes held state WITHOUT emitting press
   * edges. Set on connect and resume so a button that happens to be held across
   * a reconnection or a focus return does not fire a phantom in-game action.
   */
  private resyncEdges = true;

  constructor(
    slotId: PlayerSlotId,
    deviceIndex: number,
    source: GamepadSource,
    config: GamepadConfig,
  ) {
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0) {
      throw new InvalidDeviceIndexError(slotId, deviceIndex);
    }
    this.slotId = slotId;
    this.deviceIndex = deviceIndex;
    this.source = source;
    this.config = config;
  }

  /** Edge-triggered: true only on the frame an action's button went down. */
  pressed = (action: string): boolean => this.edges.has(action);

  /**
   * Raise an action edge imperatively (e.g. from a UI button). It surfaces at
   * the next `sample` for exactly one frame. A gamepad rarely needs this — edges
   * come from polling — but the contract offers it and honouring it keeps the
   * slot substitutable for any other `InputState`.
   */
  press = (action: string): void => {
    if (this.disposed || this.suspended) return;
    this.injectedEdges.add(action);
  };

  /** True while a live, connected device is backing this slot. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** True while suspended by focus loss / BFCache; sampling yields neutral state. */
  get isSuspended(): boolean {
    return this.suspended;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Poll the bound device and update this slot's state for one frame.
   *
   * Throws `InvalidTimeStepError` for a bad dt, and one of the device errors for
   * a malformed device — in the latter case the slot is left fully released
   * first, so a caught error never corresponds to a stuck button.
   */
  sample(dt: number): void {
    if (this.disposed) throw new DisposedError(`slot ${String(this.slotId)}`);
    const clampedDt = this.clampTimeStep(dt);

    if (this.suspended) {
      this.releaseAll();
      this.edges = new Set();
      this.injectedEdges.clear();
      this.prevHeld = new Set();
      return;
    }

    const snapshot = this.source.poll(this.deviceIndex);
    const present = snapshot !== null && snapshot.connected;

    if (!present) {
      // Connect -> absent, or simply absent: release everything and arm resync
      // so a later reconnection does not fire phantom edges.
      this.connected = false;
      this.resyncEdges = true;
      this.releaseAll();
      this.edges = new Set();
      this.injectedEdges.clear();
      this.prevHeld = new Set();
      return;
    }

    let parsed: ParsedSnapshot;
    try {
      parsed = this.parse(snapshot);
    } catch (error) {
      // Refuse loudly, but never keep the malformed frame's would-be state.
      this.connected = false;
      this.resyncEdges = true;
      this.releaseAll();
      this.edges = new Set();
      this.injectedEdges.clear();
      this.prevHeld = new Set();
      throw error;
    }

    if (!this.connected) {
      this.connected = true;
      this.resyncEdges = true;
    }

    this.applyMove(parsed);
    this.applyLook(parsed, clampedDt);
    this.applyButtons(parsed);
    this.computeEdges();
  }

  /**
   * Suspend sampling: release all held state now, and make subsequent samples
   * yield neutral state until `resume`. Used for focus loss and BFCache entry.
   */
  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.resyncEdges = true;
    this.releaseAll();
    this.edges = new Set();
    this.injectedEdges.clear();
    this.prevHeld = new Set();
  }

  /** Resume sampling after a suspend. The next sample re-reads the device fresh. */
  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.connected = false;
    this.resyncEdges = true;
  }

  /**
   * Immediately release all held state without changing suspend/connect status.
   * Exposed so a manager can drop a slot's input on `gamepaddisconnected`
   * without waiting for the next poll.
   */
  release(): void {
    if (this.disposed) return;
    this.connected = false;
    this.resyncEdges = true;
    this.releaseAll();
    this.edges = new Set();
    this.injectedEdges.clear();
    this.prevHeld = new Set();
  }

  /** Permanently release and detach this slot. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.suspended = false;
    this.connected = false;
    this.releaseAll();
    this.edges = new Set();
    this.injectedEdges.clear();
    this.prevHeld = new Set();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private clampTimeStep(dt: number): number {
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) {
      throw new InvalidTimeStepError(dt);
    }
    return Math.min(dt, this.config.maxTimeStepSeconds);
  }

  private applyMove(parsed: ParsedSnapshot): void {
    const shaped = shapeStick(
      parsed.leftX,
      parsed.leftY,
      this.config.stickDeadzone,
      this.config.stickOuterZone,
    );
    this.move.x = shaped.x;
    // Stick Y is positive-down; the contract's move.y is positive-forward.
    this.move.y = -shaped.y;
  }

  private applyLook(parsed: ParsedSnapshot, dt: number): void {
    const shaped = shapeStick(
      parsed.rightX,
      parsed.rightY,
      this.config.stickDeadzone,
      this.config.stickOuterZone,
    );
    const { x: rateX, y: rateY } = this.config.lookSpeedRadiansPerSecond;
    this.look.x = lookDelta(shaped.x, rateX, dt);
    // Non-inverted default: stick up (shaped.y < 0) looks up. invertLookY flips it.
    const ySign = this.config.invertLookY ? -1 : 1;
    this.look.y = lookDelta(shaped.y, rateY, dt) * ySign;
  }

  private applyButtons(parsed: ParsedSnapshot): void {
    this.held.clear();
    this.jump = this.readAction(parsed, 'jump');
    this.crouch = this.readAction(parsed, 'crouch');
    this.sprint = this.readAction(parsed, 'sprint');
    this.fire = this.readAction(parsed, 'fire');
    this.aim = this.readAction(parsed, 'aim');
    this.reload = this.readAction(parsed, 'reload');
  }

  private readAction(parsed: ParsedSnapshot, action: GamepadAction): boolean {
    const button = parsed.buttons[ACTION_BUTTON[action]];
    const down = TRIGGER_ACTIONS.has(action)
      ? button.pressed || button.value >= this.config.triggerThreshold
      : button.pressed;
    if (down) this.held.add(action);
    return down;
  }

  private computeEdges(): void {
    const next = new Set<string>();
    if (!this.resyncEdges) {
      for (const action of this.held) {
        if (!this.prevHeld.has(action)) next.add(action);
      }
    } else {
      this.resyncEdges = false;
    }
    for (const injected of this.injectedEdges) next.add(injected);
    this.injectedEdges.clear();
    this.edges = next;
    this.prevHeld = new Set(this.held);
  }

  private releaseAll(): void {
    this.move.x = 0;
    this.move.y = 0;
    this.look.x = 0;
    this.look.y = 0;
    this.jump = false;
    this.crouch = false;
    this.sprint = false;
    this.fire = false;
    this.aim = false;
    this.reload = false;
    this.held.clear();
  }

  private parse(snapshot: GamepadSnapshot): ParsedSnapshot {
    if (this.config.requireStandardMapping && snapshot.mapping !== STANDARD_MAPPING) {
      throw new UnsupportedMappingError(
        this.slotId,
        this.deviceIndex,
        snapshot.mapping,
        snapshot.id,
      );
    }
    if (!Array.isArray(snapshot.axes) || snapshot.axes.length < REQUIRED_AXIS_COUNT) {
      throw new MalformedGamepadError(
        this.slotId,
        this.deviceIndex,
        'axes',
        `has ${arrayLength(snapshot.axes)}, need >= ${REQUIRED_AXIS_COUNT}`,
        snapshot.id,
      );
    }
    if (!Array.isArray(snapshot.buttons) || snapshot.buttons.length < REQUIRED_BUTTON_COUNT) {
      throw new MalformedGamepadError(
        this.slotId,
        this.deviceIndex,
        'buttons',
        `has ${arrayLength(snapshot.buttons)}, need >= ${REQUIRED_BUTTON_COUNT}`,
        snapshot.id,
      );
    }

    const leftX = this.readAxis(snapshot, AXIS.leftX);
    const leftY = this.readAxis(snapshot, AXIS.leftY);
    const rightX = this.readAxis(snapshot, AXIS.rightX);
    const rightY = this.readAxis(snapshot, AXIS.rightY);

    const buttons: GamepadButtonSnapshot[] = [];
    for (const action of GAMEPAD_ACTIONS) {
      const index = ACTION_BUTTON[action];
      const button = snapshot.buttons[index];
      if (
        !button
        || typeof button.pressed !== 'boolean'
        || typeof button.value !== 'number'
      ) {
        throw new MalformedGamepadError(
          this.slotId,
          this.deviceIndex,
          'button-shape',
          `button [${index}] is not a { pressed, value } record`,
          snapshot.id,
        );
      }
      if (!Number.isFinite(button.value)) {
        throw new NonFiniteButtonError(
          this.slotId,
          this.deviceIndex,
          index,
          button.value,
          snapshot.id,
        );
      }
      buttons[index] = { pressed: button.pressed, value: clamp(button.value, 0, 1) };
    }

    return { leftX, leftY, rightX, rightY, buttons };
  }

  private readAxis(snapshot: GamepadSnapshot, index: number): number {
    const raw = snapshot.axes[index];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new NonFiniteAxisError(this.slotId, this.deviceIndex, index, raw, snapshot.id);
    }
    // Finite but out-of-range values are clamped, not refused: some drivers
    // report a hair beyond ±1, which is a range quirk, not corruption.
    return clamp(raw, -1, 1);
  }
}

function arrayLength(value: unknown): number | string {
  return Array.isArray(value) ? value.length : 'non-array';
}
