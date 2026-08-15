/**
 * Static collision contract for the vertical slice (issue #32).
 *
 * The slice ships only axis-aligned boxes. This is not a simplification for
 * convenience: the player motor's swept solver is verified against flat floors,
 * steps and vertical walls, and is NOT verified on sloped surfaces (issue #2,
 * draft PRs #3/#13 — a finite-solid ramp fixture produces airborne ticks and
 * 45-57mm vertical pops). Restricting the world to axis-aligned boxes makes the
 * unverified code path unreachable rather than merely untested.
 *
 * Sloped geometry returns through its own issue, with its own fixture, and this
 * contract widens at that point and not before.
 */

export type Vec3 = readonly [number, number, number];

export interface StaticBox {
  /** Minimum corner in world space, metres. */
  readonly min: Vec3;
  /** Maximum corner in world space, metres. */
  readonly max: Vec3;
  /** Surface identity for footstep/impact response. */
  readonly material: SurfaceMaterial;
}

export type SurfaceMaterial = 'concrete' | 'metal' | 'wood' | 'dirt';

export interface StaticWorld {
  readonly boxes: readonly StaticBox[];
  /** Play boundary; the motor clamps to this so a player cannot leave the level. */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
}

export class InvalidStaticWorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStaticWorldError';
  }
}

/**
 * Throws unless every box is a well-formed, non-degenerate AABB inside bounds.
 *
 * This is the guard that keeps the unverified slope path unreachable. It must
 * throw rather than warn: a world that silently degrades is exactly the kind of
 * quiet failure this project refuses everywhere else.
 */
export function assertValidStaticWorld(world: StaticWorld): void {
  if (!world || !Array.isArray(world.boxes)) {
    throw new InvalidStaticWorldError('static world must carry a boxes array');
  }
  if (world.boxes.length === 0) {
    throw new InvalidStaticWorldError('static world has no boxes; the player would fall forever');
  }

  const { min: bMin, max: bMax } = world.bounds;
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(bMin[axis]) || !Number.isFinite(bMax[axis])) {
      throw new InvalidStaticWorldError(`bounds axis ${axis} is not finite`);
    }
    if (bMax[axis] <= bMin[axis]) {
      throw new InvalidStaticWorldError(`bounds axis ${axis} is inverted or degenerate`);
    }
  }

  world.boxes.forEach((box, index) => {
    for (let axis = 0; axis < 3; axis++) {
      const lo = box.min[axis];
      const hi = box.max[axis];
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new InvalidStaticWorldError(`box ${index} axis ${axis} is not finite`);
      }
      if (hi <= lo) {
        throw new InvalidStaticWorldError(
          `box ${index} axis ${axis} is degenerate (${lo} >= ${hi}); zero-thickness solids ` +
            'produce undefined sweep normals',
        );
      }
      if (lo < bMin[axis] - 1e-6 || hi > bMax[axis] + 1e-6) {
        throw new InvalidStaticWorldError(`box ${index} axis ${axis} escapes the declared bounds`);
      }
    }
  });
}
