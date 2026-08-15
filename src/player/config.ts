export interface PlayerTuning {
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
  jumpHeight: number;
  maxStepHeight: number;
  groundSnapDistance: number;
  maxWalkSlopeDegrees: number;
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
  jumpHeight: 1.05,
  maxStepHeight: 0.34,
  groundSnapDistance: 0.08,
  maxWalkSlopeDegrees: 50,
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

export function jumpSpeedForHeight(tuning: Readonly<PlayerTuning>): number {
  return Math.sqrt(2 * tuning.gravity * tuning.jumpHeight);
}

export function pixelsPerFullTurn(sensitivityRadPerPixel: number): number {
  return Math.PI * 2 / sensitivityRadPerPixel;
}
