/**
 * Perception: does the enemy see the target THIS tick?
 *
 * Three independent gates, all of which must pass — range, field of view, and
 * an unobstructed line. Any one failing is what makes the enemy fallible: it
 * cannot see behind itself, cannot see past the arena's boxes, and cannot see
 * past its sight range. The gates are separated so the evidence can attribute a
 * failure to the specific reason (behind cover, out of cone, too far).
 *
 * This is a pure function with no per-call allocation so the agent can call it
 * every fixed step without generating garbage.
 */

import type { StaticWorld, Vec3 } from './types.js';
import { lineOfSightClear } from './world.js';

export interface SightParams {
  visionDistance: number;
  visionHalfAngleRadians: number;
}

/**
 * `eye` is the observer's eye position, `forward` its unit facing (any length is
 * tolerated but a unit vector is expected), `targetPoint` the world point on the
 * target that the ray aims at.
 */
export function canSee(
  eye: Vec3,
  forward: Vec3,
  targetPoint: Vec3,
  world: StaticWorld,
  params: SightParams,
): boolean {
  const dx = targetPoint.x - eye.x;
  const dy = targetPoint.y - eye.y;
  const dz = targetPoint.z - eye.z;

  const distSq = dx * dx + dy * dy + dz * dz;
  const range = params.visionDistance;
  if (distSq > range * range) return false;

  const dist = Math.sqrt(distSq);
  if (dist < 1e-6) return true; // effectively co-located

  // Field of view: angle between facing and the target direction.
  const inv = 1 / dist;
  const fLen = Math.sqrt(forward.x * forward.x + forward.y * forward.y + forward.z * forward.z) || 1;
  const cosAngle =
    (forward.x * dx + forward.y * dy + forward.z * dz) * inv / fLen;
  if (cosAngle < Math.cos(params.visionHalfAngleRadians)) return false;

  // Occlusion last: it is the most expensive gate, so short-circuit on the
  // cheap range and cone gates first.
  return lineOfSightClear(world, eye, targetPoint);
}
