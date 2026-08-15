/**
 * Spawn clearance geometry — the honest half of "two floor-based spawn slots".
 *
 * A spawn point is only as trustworthy as the proof that a standing player
 * capsule actually fits there. This module derives and validates spawns against
 * the *real* collidable solids of an `ArenaDefinition`, so a slot is never a
 * coordinate an author eyeballed. It is pure, browser-free and framework-free:
 * axis-aligned box maths only, matching the level's box-world contract (#32).
 *
 * The capsule model mirrors the shipping player (`src/player/config.ts`): a
 * vertical cylinder of `PLAYER_CAPSULE_RADIUS` from the feet at the floor up to
 * `PLAYER_STANDING_HEIGHT`. A solid obstructs a feet point when the cylinder
 * overlaps it horizontally *and* the solid rises above the floor into the
 * capsule's span. Floor slabs (top at y≈0) are the surface the feet rest on, not
 * an obstruction, so they are excluded exactly the way the AI occluder filter
 * excludes them (`box.max[1] > ~0`).
 */

import type { ArenaDefinition, Solid, Vec3 } from '../level/arena.js';

/** Capsule half-width. Mirrors DEFAULT_PLAYER_TUNING.radius (src/player/config.ts). */
export const PLAYER_CAPSULE_RADIUS = 0.34;
/** Standing capsule height. Mirrors DEFAULT_PLAYER_TUNING.standingHeight. */
export const PLAYER_STANDING_HEIGHT = 1.78;
/** A solid whose top is at/below this reads as floor, not cover. */
export const FLOOR_SURFACE_EPS = 0.02;

export interface ClearanceOptions {
  readonly radius?: number;
  readonly height?: number;
}

export interface ClearanceResult {
  /** The capsule stands clear of every obstruction AND over a floor slab. */
  readonly clear: boolean;
  /** A floor slab exists directly under the feet. */
  readonly onFloor: boolean;
  /** The first solid the capsule intersects, if any. */
  readonly blockingSolidId?: string;
  readonly reason?: string;
}

function resolved(opts: ClearanceOptions | undefined): { radius: number; height: number } {
  return {
    radius: opts?.radius ?? PLAYER_CAPSULE_RADIUS,
    height: opts?.height ?? PLAYER_STANDING_HEIGHT,
  };
}

/** Horizontal distance² from `(x,z)` to a solid's XZ rectangle (0 when inside). */
function planarGap2(x: number, z: number, solid: Solid): number {
  const dx = Math.max(solid.min[0] - x, 0, x - solid.max[0]);
  const dz = Math.max(solid.min[2] - z, 0, z - solid.max[2]);
  return dx * dx + dz * dz;
}

/** True if `solid` is a floor slab (a collidable box whose top sits at y≈0). */
export function isFloorSlab(solid: Solid): boolean {
  return solid.collide
    && Math.abs(solid.max[1]) <= FLOOR_SURFACE_EPS
    && solid.min[1] < -FLOOR_SURFACE_EPS;
}

/** True if `solid` rises above the floor and so could obstruct a standing capsule. */
function isObstruction(solid: Solid): boolean {
  return solid.collide && solid.max[1] > FLOOR_SURFACE_EPS;
}

/** True if a floor slab lies directly beneath `(x,z)`. */
export function standsOnFloor(point: Vec3, solids: readonly Solid[]): boolean {
  const [x, , z] = point;
  for (const solid of solids) {
    if (!isFloorSlab(solid)) continue;
    if (x >= solid.min[0] && x <= solid.max[0] && z >= solid.min[2] && z <= solid.max[2]) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a feet point against every solid: it must sit over floor and keep the
 * standing capsule out of every obstruction. Returns the first blocker for
 * diagnostics rather than a bare boolean.
 */
export function evaluateClearance(
  point: Vec3,
  solids: readonly Solid[],
  opts?: ClearanceOptions,
): ClearanceResult {
  const { radius, height } = resolved(opts);
  const [x, feetY, z] = point;

  if (!standsOnFloor(point, solids)) {
    return { clear: false, onFloor: false, reason: 'no floor slab beneath the feet point' };
  }

  const capsuleTop = feetY + height;
  const r2 = radius * radius;
  for (const solid of solids) {
    if (!isObstruction(solid)) continue;
    // Vertical overlap of the capsule span [feetY, capsuleTop] with the solid.
    if (solid.min[1] >= capsuleTop || solid.max[1] <= feetY) continue;
    if (planarGap2(x, z, solid) < r2) {
      return {
        clear: false,
        onFloor: true,
        blockingSolidId: solid.id,
        reason: `capsule (r=${radius}) intersects solid "${solid.id}"`,
      };
    }
  }
  return { clear: true, onFloor: true };
}

/** Convenience boolean over `evaluateClearance`. */
export function isSpawnClear(point: Vec3, solids: readonly Solid[], opts?: ClearanceOptions): boolean {
  return evaluateClearance(point, solids, opts).clear;
}

function distanceXZ(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.hypot(dx, dz);
}

/** Interior XZ rectangle: the union of collidable solids, inset by `radius`. */
export function interiorFootprint(
  solids: readonly Solid[],
  radius = PLAYER_CAPSULE_RADIUS,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const solid of solids) {
    if (!solid.collide) continue;
    if (solid.min[0] < minX) minX = solid.min[0];
    if (solid.max[0] > maxX) maxX = solid.max[0];
    if (solid.min[2] < minZ) minZ = solid.min[2];
    if (solid.max[2] > maxZ) maxZ = solid.max[2];
  }
  return { minX: minX + radius, maxX: maxX - radius, minZ: minZ + radius, maxZ: maxZ - radius };
}

export interface DeriveSpawnOptions extends ClearanceOptions {
  /** Minimum XZ separation the derived point must keep from every avoided point. */
  readonly minSeparation?: number;
  /** Points (usually the primary spawn) the derived point must stand apart from. */
  readonly avoid?: readonly Vec3[];
  /** Deterministic tactical offsets tried first, relative to `origin`, in XZ. */
  readonly preferredOffsets?: readonly (readonly [number, number])[];
  /** Grid step (metres) for the fallback interior scan. */
  readonly gridStep?: number;
}

export interface DerivedSpawn {
  readonly position: Vec3;
  /** How the point was found: a listed offset, or the deterministic grid scan. */
  readonly method: 'preferred-offset' | 'grid-scan';
  /** Candidate points inspected before this one was accepted. */
  readonly attempts: number;
}

const DEFAULT_OFFSETS: readonly (readonly [number, number])[] = [
  [2.6, 0], [-2.6, 0], [3.6, 0], [-3.6, 0],
  [2.6, -1.6], [-2.6, -1.6], [1.8, 1.2], [-1.8, 1.2],
];

/**
 * Derive a second floor spawn near `origin` that a standing capsule provably
 * fits, keeping `minSeparation` from every `avoid` point. Tries the tactical
 * offsets in order, then a deterministic interior grid scan. **Throws** if no
 * clear point exists — it never invents a coordinate inside solids, which is the
 * whole reason this function exists rather than a hand-typed literal.
 */
export function deriveClearFloorSpawn(
  arena: ArenaDefinition,
  origin: Vec3,
  opts: DeriveSpawnOptions = {},
): DerivedSpawn {
  const solids = arena.solids;
  const { radius, height } = resolved(opts);
  const minSep = opts.minSeparation ?? 2.0;
  const avoid = opts.avoid ?? [origin];
  const offsets = opts.preferredOffsets ?? DEFAULT_OFFSETS;
  const clearanceOpts: ClearanceOptions = { radius, height };
  let attempts = 0;

  const farEnough = (p: Vec3): boolean => avoid.every((a) => distanceXZ(p, a) >= minSep);

  for (const [dx, dz] of offsets) {
    const candidate: Vec3 = [origin[0] + dx, 0, origin[2] + dz];
    attempts++;
    if (farEnough(candidate) && isSpawnClear(candidate, solids, clearanceOpts)) {
      return { position: candidate, method: 'preferred-offset', attempts };
    }
  }

  // Deterministic interior scan: row-major, quantised to the grid step so the
  // result is reproducible across runs and machines.
  const step = opts.gridStep ?? 0.5;
  const box = interiorFootprint(solids, radius);
  const q = (v: number): number => Math.round(v / step) * step;
  for (let z = q(box.minZ); z <= box.maxZ + 1e-9; z += step) {
    for (let x = q(box.minX); x <= box.maxX + 1e-9; x += step) {
      const candidate: Vec3 = [Number(x.toFixed(4)), 0, Number(z.toFixed(4))];
      attempts++;
      if (farEnough(candidate) && isSpawnClear(candidate, solids, clearanceOpts)) {
        return { position: candidate, method: 'grid-scan', attempts };
      }
    }
  }

  throw new Error(
    `deriveClearFloorSpawn: no clear floor point within the interior keeps `
      + `${minSep} m from ${avoid.length} avoided point(s) after ${attempts} candidates`,
  );
}
