/**
 * Player subsystem public surface.
 *
 * The world is always axis-aligned boxes (`StaticWorld` from core). There is no
 * export that ingests arbitrary geometry, because the slope solver behind that
 * path is unverified (issue #36, parent #32).
 */

import type { InputState } from '../core/contracts.js';
import { PlayerInput } from './PlayerInput.js';
import { PlayerSystem, type PlayerSystemOptions } from './PlayerSystem.js';

export {
  DEFAULT_PLAYER_TUNING,
  GROUND_NORMAL_MIN_Y,
  jumpSpeedForHeight,
  pixelsPerFullTurn,
  type PlayerTuning,
} from './config.js';
export { PlayerInput } from './PlayerInput.js';
export {
  PlayerMotor,
  type PlayerMotorEvents,
  type PlayerMotorInput,
  type PlayerMotorSnapshot,
} from './PlayerMotor.js';
export {
  PlayerSystem,
  type PlayerSystemOptions,
} from './PlayerSystem.js';
export {
  StaticBoxWorld,
  type CapsuleContact,
  type CapsuleMoveOptions,
  type CapsuleMoveResult,
} from './StaticBoxWorld.js';
export {
  PlayerCalibrationLevel,
  createPlayerCalibrationWorld,
} from './PlayerCalibrationLevel.js';

export interface PlayerBundle {
  input: PlayerInput;
  system: PlayerSystem;
}

/**
 * Wires a browser-driven player: a pointer-lock input provider plus the system.
 * Pass the same `StaticWorld` the level was built from so what is drawn is what
 * is collided.
 */
export function createPlayer(
  canvas: HTMLCanvasElement,
  options: PlayerSystemOptions,
): PlayerBundle {
  const input = new PlayerInput(canvas, options.tuning?.lookSensitivityRadPerPixel);
  return {
    input,
    system: new PlayerSystem(input, options),
  };
}

/** A player wired to a caller-supplied `InputState` (harness / headless use). */
export function createPlayerWithInput(
  input: InputState | undefined,
  options: PlayerSystemOptions,
): PlayerSystem {
  return new PlayerSystem(input, options);
}
