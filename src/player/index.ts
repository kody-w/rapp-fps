import type * as THREE from 'three';
import { PlayerInput } from './PlayerInput.js';
import {
  PlayerSystem,
  type PlayerSystemOptions,
} from './PlayerSystem.js';

export {
  DEFAULT_PLAYER_TUNING,
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
  StaticCollisionWorld,
  type CapsuleContact,
  type CapsuleMoveOptions,
  type CapsuleMoveResult,
} from './StaticCollisionWorld.js';

export interface PlayerBundle {
  input: PlayerInput;
  system: PlayerSystem;
}

export function createPlayer(
  canvas: HTMLCanvasElement,
  options: PlayerSystemOptions = {},
): PlayerBundle {
  const input = new PlayerInput(
    canvas,
    options.tuning?.lookSensitivityRadPerPixel,
  );
  return {
    input,
    system: new PlayerSystem(input, options),
  };
}

export type PlayerSpawn = THREE.Vector3;
