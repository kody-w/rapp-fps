/**
 * Shared vocabulary for the co-op gamepad input library.
 *
 * These are the small types every other file in this directory agrees on: what
 * a player slot is named by, the six actions a gamepad drives, and the plain
 * data shape a gamepad reports each poll. They live here, apart from any logic,
 * so `errors.ts`, `seams.ts`, `mapping.ts` and the runtime can import them
 * without importing each other.
 */

/**
 * How a player slot is addressed. A number is the natural couch-co-op index
 * (player 0..3); a string lets a host name slots ("p1", "guest") if it prefers.
 */
export type PlayerSlotId = number | string;

/** The six binary/analog actions this library resolves from a standard pad. */
export type GamepadAction = 'jump' | 'crouch' | 'sprint' | 'fire' | 'aim' | 'reload';

/** One button as the Gamepad API reports it: a digital flag and an analog value. */
export interface GamepadButtonSnapshot {
  readonly pressed: boolean;
  readonly value: number;
}

/**
 * A read-only, structurally-cloned view of one `Gamepad` at one instant.
 *
 * The library never holds the live `Gamepad` object the browser hands back
 * (that object mutates under you between polls); a seam copies the fields we
 * care about into this immutable shape so a frame's input is a stable value.
 * Node fixtures construct these directly, which is the whole point of the seam:
 * no browser is required to exercise the mapping and lifecycle.
 */
export interface GamepadSnapshot {
  /** The hardware index this device occupies in `navigator.getGamepads()`. */
  readonly index: number;
  /** The browser's device id string, used only for diagnostics. */
  readonly id: string;
  /** False once the browser has reported the device gone. */
  readonly connected: boolean;
  /** `"standard"` for a W3C-mapped pad; anything else is refused by default. */
  readonly mapping: string;
  /** Axis values, nominally in [-1, 1]; indices 0..3 are the two sticks. */
  readonly axes: readonly number[];
  /** Button states; indices follow the W3C standard layout. */
  readonly buttons: readonly GamepadButtonSnapshot[];
  /** Monotonic timestamp of the sample, for staleness checks by a host. */
  readonly timestamp: number;
}
