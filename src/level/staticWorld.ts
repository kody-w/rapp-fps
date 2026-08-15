/**
 * Derives the `StaticWorld` (issue #32 collision contract) from the arena's
 * solids. This is the ONLY place collision boxes come from, and its input is the
 * exact same `Solid[]` the render meshes are built from — so the two cannot
 * drift. `assertValidStaticWorld` is the core contract's own guard; we call it
 * here and again at runtime so a malformed world throws instead of degrading.
 */

import type { StaticBox, StaticWorld, Vec3 as CoreVec3 } from '../core/collision.js';
import { assertValidStaticWorld } from '../core/collision.js';
import type { ArenaDefinition, Solid } from './arena.js';

/** The solids that actually participate in collision, in declaration order. */
export function collidableSolids(def: ArenaDefinition): Solid[] {
  return def.solids.filter((s) => s.collide);
}

function toStaticBox(solid: Solid): StaticBox {
  return {
    min: solid.min as CoreVec3,
    max: solid.max as CoreVec3,
    material: solid.surface,
  };
}

/**
 * Play bounds: the tight union of every box, expanded by a small margin so each
 * box sits strictly inside (the contract rejects a box touching the boundary
 * within its own epsilon) and the motor has a hard backstop outside the walls.
 */
function computeBounds(boxes: readonly StaticBox[]): StaticWorld['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < min[a]) min[a] = b.min[a];
      if (b.max[a] > max[a]) max[a] = b.max[a];
    }
  }
  const margin = 0.5;
  return {
    min: [min[0] - margin, min[1] - margin, min[2] - margin],
    max: [max[0] + margin, max[1] + margin, max[2] + margin],
  };
}

export function buildStaticWorld(def: ArenaDefinition): StaticWorld {
  const boxes = collidableSolids(def).map(toStaticBox);
  const world: StaticWorld = { boxes, bounds: computeBounds(boxes) };
  assertValidStaticWorld(world);
  return world;
}
