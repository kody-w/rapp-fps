import type { Vec3 } from './types.js';

export const ENEMY_TRACER_MAX_LENGTH = 2.4;
export const ENEMY_TRACER_LIFETIME_SECONDS = 0.055;
export const ENEMY_TRACER_CAMERA_CLEARANCE = 0.6;
export const ENEMY_TRACER_RADIUS = 0.004;
export const ENEMY_TRACER_TARGET_CSS_PIXELS = 3;
export const ENEMY_TRACER_MAX_CSS_PIXELS = 4;

export interface TracerSegment {
  center: Vec3;
  direction: Vec3;
  length: number;
}

/**
 * Short visual segment near the muzzle, never the authoritative bullet ray.
 * If the shot line passes close to the camera, truncate before it; if the
 * muzzle is already inside the clearance radius, hide instead of drawing
 * through/behind the near plane.
 */
export function computeTracerSegment(
  origin: Vec3,
  direction: Vec3,
  camera: Vec3,
): TracerSegment | null {
  if (!finite(origin) || !finite(direction) || !finite(camera)) return null;
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (magnitude <= 1e-9) return null;
  const normal = {
    x: direction.x / magnitude,
    y: direction.y / magnitude,
    z: direction.z / magnitude,
  };
  const cx = camera.x - origin.x;
  const cy = camera.y - origin.y;
  const cz = camera.z - origin.z;
  const along = cx * normal.x + cy * normal.y + cz * normal.z;
  const lateralSq = Math.max(0, cx * cx + cy * cy + cz * cz - along * along);

  let length = ENEMY_TRACER_MAX_LENGTH;
  if (along > 0 && lateralSq <= ENEMY_TRACER_CAMERA_CLEARANCE ** 2) {
    length = Math.min(length, along - ENEMY_TRACER_CAMERA_CLEARANCE);
  }
  if (!Number.isFinite(length) || length <= 0.02) return null;

  return {
    center: {
      x: origin.x + normal.x * length * 0.5,
      y: origin.y + normal.y * length * 0.5,
      z: origin.z + normal.z * length * 0.5,
    },
    direction: normal,
    length,
  };
}

export function projectedTracerWidthCssPixels(
  verticalFovRadians: number,
  viewportHeightCssPixels: number,
  nearestDepth: number,
  radius = ENEMY_TRACER_RADIUS,
): number {
  if (
    !Number.isFinite(verticalFovRadians)
    || !Number.isFinite(viewportHeightCssPixels)
    || !Number.isFinite(nearestDepth)
    || verticalFovRadians <= 0
    || verticalFovRadians >= Math.PI
    || viewportHeightCssPixels <= 0
    || nearestDepth <= 0
  ) return Infinity;
  const focalScale = 1 / Math.tan(verticalFovRadians * 0.5);
  return radius * viewportHeightCssPixels * focalScale / nearestDepth;
}

export function tracerWorldRadiusForCssPixels(
  verticalFovRadians: number,
  viewportHeightCssPixels: number,
  nearestDepth: number,
): number {
  const focalScale = 1 / Math.tan(verticalFovRadians * 0.5);
  if (
    !Number.isFinite(focalScale)
    || !Number.isFinite(viewportHeightCssPixels)
    || !Number.isFinite(nearestDepth)
    || focalScale <= 0
    || viewportHeightCssPixels <= 0
    || nearestDepth <= 0
  ) return 0;
  return ENEMY_TRACER_TARGET_CSS_PIXELS
    * nearestDepth
    / (viewportHeightCssPixels * focalScale);
}

export function nearestTracerDepth(
  centerDepth: number,
  directionDotCameraForward: number,
  length: number,
): number {
  if (
    !Number.isFinite(centerDepth)
    || !Number.isFinite(directionDotCameraForward)
    || !Number.isFinite(length)
    || length < 0
  ) return -Infinity;
  return centerDepth - Math.abs(directionDotCameraForward) * length * 0.5;
}

function finite(vector: Vec3): boolean {
  return Number.isFinite(vector.x)
    && Number.isFinite(vector.y)
    && Number.isFinite(vector.z);
}
