/**
 * Pure, headless line-of-sight against the arena's collidable solids.
 *
 * A sightline is an infinitely thin segment from an eye to a target; a solid
 * blocks it iff the segment intersects that solid's AABB. This is a standard
 * slab test — exact for the axis-aligned box world (issue #32) and free of any
 * `three`/DOM dependency, so the spawn-clearance / initial-LOS policy proof and
 * the topology fingerprint can both run in Node and in the browser harness with
 * identical results.
 *
 * It operates on `Solid` records (which carry ids) rather than raw `StaticBox`es
 * so an occluder can be *named* in the evidence, not just counted.
 */

import type { Solid, Vec3 } from '../../arena.js';

const EPS = 1e-9;

/**
 * Segment vs AABB (slab method). Returns true if the closed segment p0→p1
 * intersects the box [min,max]. Endpoints inside the box count as hits.
 */
export function segmentIntersectsAABB(
  p0: Vec3,
  p1: Vec3,
  min: Vec3,
  max: Vec3,
): boolean {
  let tMin = 0;
  let tMax = 1;
  for (let a = 0; a < 3; a++) {
    const start = p0[a];
    const dir = p1[a] - start;
    const lo = min[a];
    const hi = max[a];
    if (Math.abs(dir) < EPS) {
      // Parallel to this slab: must already lie within it.
      if (start < lo || start > hi) return false;
      continue;
    }
    const inv = 1 / dir;
    let t1 = (lo - start) * inv;
    let t2 = (hi - start) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  return true;
}

export interface Occluder {
  readonly id: string;
  /** Parametric distance along p0→p1 at which the box is first entered (0..1). */
  readonly t: number;
}

/**
 * The first collidable solid (nearest to `from`) that blocks the sightline
 * `from`→`to`, ignoring any ids in `ignore` (e.g. the target's own solid).
 * Returns null when the line is clear.
 */
export function firstOccluder(
  collidable: readonly Solid[],
  from: Vec3,
  to: Vec3,
  ignore: readonly string[] = [],
): Occluder | null {
  const skip = new Set(ignore);
  let best: Occluder | null = null;
  for (const s of collidable) {
    if (skip.has(s.id)) continue;
    if (!segmentIntersectsAABB(from, to, s.min, s.max)) continue;
    const t = entryParam(from, to, s.min, s.max);
    if (!best || t < best.t) best = { id: s.id, t };
  }
  return best;
}

/** True when nothing blocks the sightline `from`→`to`. */
export function hasClearLineOfSight(
  collidable: readonly Solid[],
  from: Vec3,
  to: Vec3,
  ignore: readonly string[] = [],
): boolean {
  return firstOccluder(collidable, from, to, ignore) === null;
}

/** Entry parameter (0..1) where the segment first crosses into the box. */
function entryParam(p0: Vec3, p1: Vec3, min: Vec3, max: Vec3): number {
  let tMin = 0;
  for (let a = 0; a < 3; a++) {
    const start = p0[a];
    const dir = p1[a] - start;
    if (Math.abs(dir) < EPS) continue;
    const inv = 1 / dir;
    const t1 = (min[a] - start) * inv;
    const t2 = (max[a] - start) * inv;
    const near = Math.min(t1, t2);
    if (near > tMin) tMin = near;
  }
  return tMin;
}
