/**
 * Typed, loud errors for the co-op gamepad input library.
 *
 * The design rule for this subsystem is "prefer a loud typed error over a
 * silently-accepted malformed device". A gamepad that reports a NaN axis, a
 * truncated button array, or a non-`standard` mapping is not a device we can
 * safely map to movement and aim — accepting it silently would surface later as
 * a player who cannot turn, or a stuck trigger, with no trail back to the cause.
 * So the seam that reads a device throws one of these instead, every offending
 * frame, carrying the slot and device index so a host can decide what to do
 * (log, drop the slot, show a "reconnect controller" prompt) with full context.
 *
 * Every error here extends `CoopInputError`, so a host can catch the whole
 * family with one `instanceof` and still switch on the concrete subtype. The
 * `code` field is a stable string for logs and tests that must not depend on
 * message wording.
 */

import type { PlayerSlotId } from './types.js';

export type CoopInputErrorCode =
  | 'malformed-gamepad'
  | 'non-finite-axis'
  | 'non-finite-button'
  | 'unsupported-mapping'
  | 'invalid-time-step'
  | 'invalid-device-index'
  | 'duplicate-slot'
  | 'unknown-slot'
  | 'disposed';

/** Base class for every fault this library raises. Catch this to catch them all. */
export class CoopInputError extends Error {
  readonly code: CoopInputErrorCode;

  constructor(code: CoopInputErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    // Preserve a correct prototype chain when compiled down to ES5-style
    // constructors; harmless on ES2022 and keeps `instanceof` reliable.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The device is structurally wrong: too few axes or buttons to hold the
 * standard mapping, or a button entry missing its `pressed`/`value` shape. The
 * `field` names what was short and `detail` says by how much.
 */
export class MalformedGamepadError extends CoopInputError {
  constructor(
    readonly slot: PlayerSlotId,
    readonly deviceIndex: number,
    readonly field: 'axes' | 'buttons' | 'button-shape',
    readonly detail: string,
    readonly deviceId: string,
  ) {
    super(
      'malformed-gamepad',
      `slot ${String(slot)} device #${deviceIndex} (${deviceId || 'unknown'}) is `
        + `malformed: ${field} ${detail}`,
    );
  }
}

/** An axis we must read (a stick component) is NaN or ±Infinity — unmappable. */
export class NonFiniteAxisError extends CoopInputError {
  constructor(
    readonly slot: PlayerSlotId,
    readonly deviceIndex: number,
    readonly axisIndex: number,
    readonly value: unknown,
    readonly deviceId: string,
  ) {
    super(
      'non-finite-axis',
      `slot ${String(slot)} device #${deviceIndex} (${deviceId || 'unknown'}) axis `
        + `[${axisIndex}] is not finite: ${String(value)}`,
    );
  }
}

/** A mapped button's analog `value` is NaN or ±Infinity — unmappable. */
export class NonFiniteButtonError extends CoopInputError {
  constructor(
    readonly slot: PlayerSlotId,
    readonly deviceIndex: number,
    readonly buttonIndex: number,
    readonly value: unknown,
    readonly deviceId: string,
  ) {
    super(
      'non-finite-button',
      `slot ${String(slot)} device #${deviceIndex} (${deviceId || 'unknown'}) button `
        + `[${buttonIndex}] value is not finite: ${String(value)}`,
    );
  }
}

/**
 * The device does not advertise the W3C `standard` mapping, so axis and button
 * indices cannot be trusted to mean left-stick, right-stick, A, RT, and so on.
 * Thrown only when `requireStandardMapping` is enabled (the default).
 */
export class UnsupportedMappingError extends CoopInputError {
  constructor(
    readonly slot: PlayerSlotId,
    readonly deviceIndex: number,
    readonly mapping: string,
    readonly deviceId: string,
  ) {
    super(
      'unsupported-mapping',
      `slot ${String(slot)} device #${deviceIndex} (${deviceId || 'unknown'}) reports `
        + `mapping "${mapping}", not "standard"; refusing to guess its layout`,
    );
  }
}

/**
 * `sample(dt)` was handed a non-finite or negative timestep. Look integration
 * multiplies by dt, so a bad dt would corrupt aim; we refuse rather than fold
 * NaN into the camera.
 */
export class InvalidTimeStepError extends CoopInputError {
  constructor(readonly value: unknown) {
    super(
      'invalid-time-step',
      `sample(dt) requires a finite, non-negative dt in seconds; got ${String(value)}`,
    );
  }
}

/** A slot was asked to bind to a device index that is not a non-negative integer. */
export class InvalidDeviceIndexError extends CoopInputError {
  constructor(readonly slot: PlayerSlotId, readonly value: unknown) {
    super(
      'invalid-device-index',
      `slot ${String(slot)} device index must be a non-negative integer; got ${String(value)}`,
    );
  }
}

/** `join` was called with a slot id that is already occupied. */
export class DuplicateSlotError extends CoopInputError {
  constructor(readonly slot: PlayerSlotId) {
    super('duplicate-slot', `slot ${String(slot)} is already joined`);
  }
}

/** `leave`/`slot` referenced a slot id that is not currently joined. */
export class UnknownSlotError extends CoopInputError {
  constructor(readonly slot: PlayerSlotId) {
    super('unknown-slot', `slot ${String(slot)} is not joined`);
  }
}

/** An operation was attempted on a manager or slot that has been disposed. */
export class DisposedError extends CoopInputError {
  constructor(readonly what: string) {
    super('disposed', `${what} has been disposed and can no longer be used`);
  }
}
