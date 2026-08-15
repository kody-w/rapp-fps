/**
 * Tuning for a gamepad slot, and the pure stick-shaping maths that depend on it.
 *
 * Everything here is data and stateless functions: deadzone shaping, saturation,
 * and the frame-rate-independent look integration. Keeping it separate from the
 * slot runtime means the shaping can be unit-reasoned about in isolation and the
 * fixtures can assert its exact numbers without constructing a whole manager.
 */

/** Per-axis look rate, in radians of camera rotation per second at full stick. */
export interface LookSpeed {
  /** Yaw rate: how fast a fully-deflected right-stick X turns the view. */
  readonly x: number;
  /** Pitch rate: how fast a fully-deflected right-stick Y tilts the view. */
  readonly y: number;
}

export interface GamepadConfig {
  /**
   * Radial inner deadzone for both sticks, 0..1. Stick magnitudes at or below
   * this are treated as centred, killing the wander a released stick reports.
   */
  readonly stickDeadzone: number;
  /**
   * Radial outer margin, 0..1. Stick magnitude at or above `1 - outer`
   * saturates to full output, so worn sticks that never quite reach the rim
   * still deliver a full run / full-speed turn.
   */
  readonly stickOuterZone: number;
  /**
   * Analog-trigger threshold, 0..1. A trigger counts as "down" for fire/aim
   * when its digital `pressed` is set OR its analog value reaches this.
   */
  readonly triggerThreshold: number;
  /** Look rate at full right-stick deflection, per axis, radians per second. */
  readonly lookSpeedRadiansPerSecond: LookSpeed;
  /** When true, pushing the right stick up looks down (classic inverted aim). */
  readonly invertLookY: boolean;
  /**
   * Upper bound applied to the dt handed to `sample`, in seconds. A tab that
   * stalls for a second must not snap the camera a second's worth of turn on
   * the resuming frame; dt is clamped to this first. Look stays frame-rate
   * independent below the clamp.
   */
  readonly maxTimeStepSeconds: number;
  /**
   * When true (default), a device must advertise `mapping === "standard"` or it
   * is refused with `UnsupportedMappingError`. Set false only if a host has its
   * own reason to trust a non-standard device's indices.
   */
  readonly requireStandardMapping: boolean;
}

/** Sensible defaults for a console-style shooter on a standard pad. */
export const DEFAULT_GAMEPAD_CONFIG: GamepadConfig = {
  stickDeadzone: 0.15,
  stickOuterZone: 0.05,
  triggerThreshold: 0.5,
  lookSpeedRadiansPerSecond: { x: 3.2, y: 2.4 },
  invertLookY: false,
  maxTimeStepSeconds: 0.1,
  requireStandardMapping: true,
};

/** Merge a partial override onto the defaults, validating the numeric ranges. */
export function resolveConfig(overrides?: Partial<GamepadConfig>): GamepadConfig {
  const merged: GamepadConfig = {
    ...DEFAULT_GAMEPAD_CONFIG,
    ...overrides,
    lookSpeedRadiansPerSecond: {
      ...DEFAULT_GAMEPAD_CONFIG.lookSpeedRadiansPerSecond,
      ...overrides?.lookSpeedRadiansPerSecond,
    },
  };
  assertUnit('stickDeadzone', merged.stickDeadzone);
  assertUnit('stickOuterZone', merged.stickOuterZone);
  assertUnit('triggerThreshold', merged.triggerThreshold);
  if (merged.stickDeadzone + merged.stickOuterZone >= 1) {
    throw new RangeError(
      `stickDeadzone (${merged.stickDeadzone}) + stickOuterZone `
        + `(${merged.stickOuterZone}) must be < 1`,
    );
  }
  assertPositive('maxTimeStepSeconds', merged.maxTimeStepSeconds);
  assertPositive('lookSpeedRadiansPerSecond.x', merged.lookSpeedRadiansPerSecond.x);
  assertPositive('lookSpeedRadiansPerSecond.y', merged.lookSpeedRadiansPerSecond.y);
  return merged;
}

/** Clamp a scalar to a closed interval. Assumes `lo <= hi`. */
export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Shape a raw stick (x right-positive, y down-positive) into a deadzoned,
 * normalised vector whose magnitude is 0 inside the inner deadzone, ramps
 * linearly to 1 at the outer edge, and never exceeds 1. Direction is preserved
 * exactly, so a diagonal push keeps its angle instead of biasing to a cardinal.
 *
 * Inputs are assumed already finite and clamped to [-1, 1] per axis by the
 * caller; this function does not police NaN — that is the seam's job so the
 * error can name the offending axis.
 */
export function shapeStick(
  x: number,
  y: number,
  deadzone: number,
  outerZone: number,
): { x: number; y: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone) return { x: 0, y: 0 };
  const outerEdge = 1 - outerZone;
  const span = outerEdge - deadzone;
  const t = clamp((magnitude - deadzone) / span, 0, 1);
  const scale = t / magnitude;
  return { x: x * scale, y: y * scale };
}

/**
 * Integrate a shaped right-stick component into a per-frame look delta in
 * radians. The stick expresses a RATE (how fast to turn), so the delta is
 * `component * rate * dt` — identical total rotation for the same wall-clock
 * time whether the game runs at 30 or 240 fps. That is the whole reason look
 * takes dt while movement does not.
 */
export function lookDelta(component: number, ratePerSecond: number, dt: number): number {
  return component * ratePerSecond * dt;
}

function assertUnit(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number in [0, 1]; got ${value}`);
  }
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number > 0; got ${value}`);
  }
}
