/**
 * Player tuning. One frozen table so feel is a data decision, not scattered
 * magic numbers, and every harness measures against the same source of truth.
 *
 * There is deliberately no walkable-slope angle here. The vertical slice
 * (issue #32, this work #36) ships an axis-aligned box world: every floor
 * normal is exactly +Y and every wall normal is exactly horizontal. The motor
 * only has to tell floor from wall, which `GROUND_NORMAL_MIN_Y` does. A
 * "maxWalkSlopeDegrees" knob would imply a capability the solver does not have
 * and the project has not verified — slopes return under their own issue.
 */

export interface PlayerTuning {
  /** Capsule radius (horizontal half-width), metres. */
  radius: number;
  standingHeight: number;
  crouchingHeight: number;
  standingEyeHeight: number;
  crouchingEyeHeight: number;
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  groundAcceleration: number;
  sprintAcceleration: number;
  groundDeceleration: number;
  airAcceleration: number;
  airControl: number;
  gravity: number;
  /** Downward speed is clamped here so a long fall cannot tunnel a thin floor. */
  terminalFallSpeed: number;
  jumpHeight: number;
  maxStepHeight: number;
  /** Ground snap reach. Intentionally >= maxStepHeight so a walker descends a
   *  step glued rather than launching, symmetric with step-up. */
  groundSnapDistance: number;
  crouchTransitionSpeed: number;
  coyoteTime: number;
  jumpBufferTime: number;
  sprintDuration: number;
  sprintRecoveryTime: number;
  sprintRecoveryDelay: number;
  walkStepLength: number;
  sprintStepLength: number;
  crouchStepLength: number;
  lookSensitivityRadPerPixel: number;
  pitchLimitRadians: number;
  bobHorizontalMeters: number;
  bobVerticalMeters: number;
  bobRollRadians: number;
  landingDipMeters: number;
}

export const DEFAULT_PLAYER_TUNING: Readonly<PlayerTuning> = Object.freeze({
  radius: 0.34,
  standingHeight: 1.78,
  crouchingHeight: 1.18,
  standingEyeHeight: 1.66,
  crouchingEyeHeight: 1.07,
  walkSpeed: 5.4,
  sprintSpeed: 7.5,
  crouchSpeed: 2.65,
  groundAcceleration: 34,
  sprintAcceleration: 38,
  groundDeceleration: 28,
  airAcceleration: 7,
  airControl: 0.32,
  gravity: 24,
  terminalFallSpeed: 55,
  jumpHeight: 1.05,
  maxStepHeight: 0.34,
  groundSnapDistance: 0.34,
  crouchTransitionSpeed: 5,
  coyoteTime: 0.09,
  jumpBufferTime: 0.12,
  sprintDuration: 3.6,
  sprintRecoveryTime: 4.5,
  sprintRecoveryDelay: 0.7,
  walkStepLength: 1.75,
  sprintStepLength: 2,
  crouchStepLength: 1.2,
  lookSensitivityRadPerPixel: 0.0018,
  pitchLimitRadians: Math.PI / 2 - 0.01,
  bobHorizontalMeters: 0.018,
  bobVerticalMeters: 0.026,
  bobRollRadians: 0.0035,
  landingDipMeters: 0.11,
});

/**
 * Floor/wall discriminator for the box world. A contact whose normal Y is at or
 * above this is standing ground; anything below is a wall or ceiling. In an
 * axis-aligned world the real values are 1 (floor) and 0 (wall), so any
 * threshold in (0,1) is correct; 0.5 leaves generous margin against float error
 * without ever admitting a slope, because no slope exists to admit.
 */
export const GROUND_NORMAL_MIN_Y = 0.5;

export function jumpSpeedForHeight(tuning: Readonly<PlayerTuning>): number {
  return Math.sqrt(2 * tuning.gravity * tuning.jumpHeight);
}

export function pixelsPerFullTurn(sensitivityRadPerPixel: number): number {
  return Math.PI * 2 / sensitivityRadPerPixel;
}
