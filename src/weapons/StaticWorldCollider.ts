/**
 * Analytic hitscan against the shipping arena's static collision contract
 * (`src/core/collision.ts`, issue #32). The arena is defined as axis-aligned
 * boxes only, so a round resolves against that exact contract with a closed-form
 * slab test — no scene-graph traversal, no triangle mesh, no per-instance
 * transform to drop. Because every solid is an AABB, the impact normal is an
 * exact unit axis, so the defect-#1 class of normal error cannot occur here at
 * all.
 *
 * The collider refuses a malformed world through `assertValidStaticWorld` rather
 * than silently degrading: the same guard the player motor relies on to keep the
 * unverified sloped-surface path unreachable also keeps ballistics honest.
 */

import * as THREE from 'three';
import { assertValidStaticWorld } from '../core/collision.js';
import type { StaticWorld, SurfaceMaterial } from '../core/collision.js';

export interface StaticWorldHit {
  /** World-space impact point. */
  readonly point: THREE.Vector3;
  /** Outward face normal — always a unit axis for an AABB. */
  readonly normal: THREE.Vector3;
  /** Distance from the ray origin to the impact, metres. */
  readonly distance: number;
  /** Surface identity of the box that was hit. */
  readonly material: SurfaceMaterial;
}

const PARALLEL_EPS = 1e-12;
const ORIGIN_EPS = 1e-6;

export class StaticWorldCollider {
  private readonly world: StaticWorld;

  constructor(world: StaticWorld) {
    // Refuse a degenerate or out-of-bounds world; never silently degrade.
    assertValidStaticWorld(world);
    this.world = world;
  }

  get boxCount(): number {
    return this.world.boxes.length;
  }

  /**
   * Nearest entry-face intersection of the ray with any box, within (0, far].
   * Rays whose origin lies inside a box are treated as a miss for that box: a
   * muzzle should never resolve from within a solid, and reporting the exit face
   * would invert the normal.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, far: number): StaticWorldHit | null {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = direction.x, dy = direction.y, dz = direction.z;

    let bestT = far;
    let hitAxis = -1;
    let hitSign = 0;
    let hitMaterial: SurfaceMaterial | null = null;

    for (const box of this.world.boxes) {
      const lox = box.min[0], loy = box.min[1], loz = box.min[2];
      const hix = box.max[0], hiy = box.max[1], hiz = box.max[2];

      let tEnter = -Infinity;
      let tExit = Infinity;
      let enterAxis = -1;
      let miss = false;

      for (let axis = 0; axis < 3; axis++) {
        const o = axis === 0 ? ox : axis === 1 ? oy : oz;
        const d = axis === 0 ? dx : axis === 1 ? dy : dz;
        const lo = axis === 0 ? lox : axis === 1 ? loy : loz;
        const hi = axis === 0 ? hix : axis === 1 ? hiy : hiz;

        if (Math.abs(d) < PARALLEL_EPS) {
          // Ray parallel to this pair of faces: outside the slab is a clean miss.
          if (o < lo || o > hi) { miss = true; break; }
          continue;
        }
        const inv = 1 / d;
        let tNear = (lo - o) * inv;
        let tFar = (hi - o) * inv;
        if (tNear > tFar) { const tmp = tNear; tNear = tFar; tFar = tmp; }
        if (tNear > tEnter) { tEnter = tNear; enterAxis = axis; }
        if (tFar < tExit) tExit = tFar;
        if (tEnter > tExit) { miss = true; break; }
      }

      if (miss || enterAxis < 0) continue;
      // Only entry faces in front of the muzzle within range count.
      if (tEnter <= ORIGIN_EPS || tEnter >= bestT) continue;

      bestT = tEnter;
      hitAxis = enterAxis;
      // A ray moving +axis enters through the low face (normal −axis) and vice versa.
      hitSign = (enterAxis === 0 ? dx : enterAxis === 1 ? dy : dz) > 0 ? -1 : 1;
      hitMaterial = box.material;
    }

    if (hitAxis < 0 || hitMaterial === null) return null;

    const point = new THREE.Vector3(
      ox + dx * bestT,
      oy + dy * bestT,
      oz + dz * bestT,
    );
    const normal = new THREE.Vector3();
    normal.setComponent(hitAxis, hitSign);
    return { point, normal, distance: bestT, material: hitMaterial };
  }
}
