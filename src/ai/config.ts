/**
 * Default tuning for the one enemy type.
 *
 * Every value here is something the harness can measure, not a taste call:
 * the reaction delay is a delay you can observe in the transition timing, the
 * vision cone is an angle the perception fixture checks, the aim scatter is a
 * spread the fire log records. Numbers are metres, seconds and radians.
 */

import type { EnemyConfig } from './types.js';
import { degToRad } from './math.js';

export const AI_FIXED_STEP_SECONDS = 1 / 120;

export const DEFAULT_ENEMY_CONFIG: EnemyConfig = {
  seed: 0x51e6d,
  fixedStepSeconds: AI_FIXED_STEP_SECONDS,

  // Perception — a wide but finite cone, sight that reaches across the arena,
  // and a reaction delay so the enemy registers the player rather than snapping.
  visionDistance: 26,
  visionHalfAngleRadians: degToRad(60), // 120° cone
  eyeHeight: 1.6,
  targetSampleHeight: 1.35,
  reactionDelaySeconds: 0.3,
  lostSightGraceSeconds: 1.4,
  hearingRadius: 13,

  investigateSeconds: 4,
  searchSeconds: 6,
  searchRadius: 3,

  moveSpeed: 3.4,
  turnSpeedRadians: degToRad(360),
  arrivalRadius: 0.4,

  repositionDwellSeconds: 3.5,
  repositionMaxSeconds: 1.8,
  damageMemorySeconds: 2,
  coverStandOff: 0.7,
  coverStanceHeight: 1.0,
  coverMinThreatSeparation: 2.5,
  coverWeightExposure: 1,
  coverWeightPath: 0.35,
  coverWeightFlank: 0.2,
  coverPathNormalize: 12,

  acquireSeconds: 0.25,
  telegraphSeconds: 0.45,
  burstCount: 3,
  shotIntervalSeconds: 0.12,
  cooldownSeconds: 1.1,
  aimErrorRadians: degToRad(3.5),

  maxHealth: 100,
  deathSettleSeconds: 1.2,
};
