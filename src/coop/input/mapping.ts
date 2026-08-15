/**
 * The W3C "standard" gamepad layout, and this library's binding of it to the
 * engine's six input actions.
 *
 * Axis and button indices below are fixed by the W3C Gamepad spec's Standard
 * Gamepad mapping (https://www.w3.org/TR/gamepad/#remapping): a device that
 * advertises `mapping === "standard"` guarantees these indices mean what the
 * names say, across Xbox, PlayStation and most third-party pads. We refuse
 * non-standard devices by default (see `UnsupportedMappingError`) precisely so
 * these constants can be trusted rather than guessed at per-vendor.
 *
 * The action binding is a conventional console-shooter layout, chosen so all
 * six engine actions land on distinct, unambiguous controls. The exact table is
 * documented in README.md; the code and the doc are generated from THIS map, so
 * they cannot drift.
 */

import type { GamepadAction } from './types.js';

/** Axis indices in the standard mapping. Y axes are positive-down. */
export const AXIS = {
  /** Left stick horizontal, right positive. */
  leftX: 0,
  /** Left stick vertical, down positive. */
  leftY: 1,
  /** Right stick horizontal, right positive. */
  rightX: 2,
  /** Right stick vertical, down positive. */
  rightY: 3,
} as const;

/** Button indices in the standard mapping that this library reads. */
export const BUTTON = {
  /** Bottom face button — A (Xbox) / Cross (PlayStation). */
  jump: 0,
  /** Right face button — B / Circle. */
  crouch: 1,
  /** Left face button — X / Square. */
  reload: 2,
  /** Left trigger — LT / L2, analog. */
  aim: 6,
  /** Right trigger — RT / R2, analog. */
  fire: 7,
  /** Left stick click — L3. */
  sprint: 10,
} as const;

/** Canonical binding from engine action to the standard button that drives it. */
export const ACTION_BUTTON: Readonly<Record<GamepadAction, number>> = {
  jump: BUTTON.jump,
  crouch: BUTTON.crouch,
  reload: BUTTON.reload,
  aim: BUTTON.aim,
  fire: BUTTON.fire,
  sprint: BUTTON.sprint,
};

/** Stable order of the six actions, for iteration and reporting. */
export const GAMEPAD_ACTIONS: readonly GamepadAction[] = [
  'jump',
  'crouch',
  'sprint',
  'fire',
  'aim',
  'reload',
];

/** Actions whose control is an analog trigger (read via a value threshold). */
export const TRIGGER_ACTIONS: ReadonlySet<GamepadAction> = new Set<GamepadAction>([
  'aim',
  'fire',
]);

/** We must be able to index the two sticks, so at least axes 0..3 are required. */
export const REQUIRED_AXIS_COUNT = 4;

/**
 * We must be able to index every mapped button. The highest mapped index is 10
 * (L3), so a standard-mapped device with fewer than 11 buttons is truncated and
 * refused. A conformant standard pad reports 17.
 */
export const REQUIRED_BUTTON_COUNT = Math.max(...Object.values(BUTTON)) + 1;

/** The `mapping` string a device must advertise to be trusted by default. */
export const STANDARD_MAPPING = 'standard';

/**
 * A single self-describing record of the whole mapping, exported so the README
 * generator and the fixtures can assert against ONE source of truth rather than
 * re-typing indices.
 */
export const STANDARD_GAMEPAD_MAPPING = {
  axes: AXIS,
  buttons: BUTTON,
  actionButton: ACTION_BUTTON,
  requiredAxisCount: REQUIRED_AXIS_COUNT,
  requiredButtonCount: REQUIRED_BUTTON_COUNT,
  mapping: STANDARD_MAPPING,
} as const;
