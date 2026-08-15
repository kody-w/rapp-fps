/**
 * Public surface of the co-op gamepad input library.
 *
 * A production host needs only `CoopInputManager`: construct it (it wires the
 * browser seams itself), `join` a slot per player, call `sample(dt)` each frame,
 * and read each slot as an `InputState`. Everything else is exported for tests,
 * replay, and hosts that want to substitute a seam or inspect a fault.
 *
 * The whole library lives under `src/coop/input/**` and imports only the shared
 * `InputState` *type* from core; it never edits or depends on the runtime of
 * `main.ts`, the player, or the renderer.
 */

export { CoopInputManager } from './CoopInputManager.js';
export type {
  CoopInputManagerOptions,
  SampleReport,
  SlotFault,
} from './CoopInputManager.js';

export { GamepadInput } from './GamepadInput.js';

export {
  DEFAULT_GAMEPAD_CONFIG,
  resolveConfig,
  clamp,
  shapeStick,
  lookDelta,
} from './config.js';
export type { GamepadConfig, LookSpeed } from './config.js';

export {
  ACTION_BUTTON,
  AXIS,
  BUTTON,
  GAMEPAD_ACTIONS,
  REQUIRED_AXIS_COUNT,
  REQUIRED_BUTTON_COUNT,
  STANDARD_GAMEPAD_MAPPING,
  STANDARD_MAPPING,
  TRIGGER_ACTIONS,
} from './mapping.js';

export {
  browserEventTarget,
  browserGamepadSource,
  snapshotOf,
} from './seams.js';
export type { EventTargetLike, GamepadSource } from './seams.js';

export {
  ManualEventTarget,
  ScriptedGamepadSource,
  makeSnapshot,
} from './scripted.js';
export type { SnapshotSpec } from './scripted.js';

export {
  CoopInputError,
  DisposedError,
  DuplicateSlotError,
  InvalidDeviceIndexError,
  InvalidTimeStepError,
  MalformedGamepadError,
  NonFiniteAxisError,
  NonFiniteButtonError,
  UnknownSlotError,
  UnsupportedMappingError,
} from './errors.js';
export type { CoopInputErrorCode } from './errors.js';

export type {
  GamepadAction,
  GamepadButtonSnapshot,
  GamepadSnapshot,
  PlayerSlotId,
} from './types.js';
