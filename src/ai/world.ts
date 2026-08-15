/**
 * The occluding world: axis-aligned boxes, and the line-of-sight test that
 * resolves against them.
 *
 * This is the piece that stops the enemy being omniscient. Sight and shots are
 * segments from the enemy's eye to a point on the target; if any box straddles
 * that segment, the enemy cannot see and does not fire. The negative case — a
 * player fully behind a crate is NOT seen — is as important as the positive one
 * and is tested explicitly, because a perception system that never fails to see
 * is not a perception system.
 *
 * The mandate expected an axis-aligned `StaticWorld` in `src/core/collision.ts`
 * with `assertValidStaticWorld`; that file is absent on `main`. To avoid a core
 * edit this module owns the equivalent, and the arena it builds is shared by
 * both the rendered `AiSystem` and the browser-free evidence so the boxes the
 * enemy reasons about are exactly the boxes on screen.
 */

import type { StaticBox, StaticWorld, Vec3 } from './types.js';

/**
 * Rejects a malformed world at construction rather than letting a degenerate
 * box silently swallow or leak rays later. Mirrors the fail-at-registration
 * discipline issue #32 asks of the collision world.
 */
export function assertValidStaticWorld(world: StaticWorld): void {
  if (!world || !Array.isArray(world.boxes)) {
    throw new Error('StaticWorld: boxes must be an array');
  }
  const seen = new Set<string>();
  for (const box of world.boxes) {
    if (!box.id) throw new Error('StaticWorld: every box needs a non-empty id');
    if (seen.has(box.id)) throw new Error(`StaticWorld: duplicate box id "${box.id}"`);
    seen.add(box.id);
    for (const axis of ['x', 'y', 'z'] as const) {
      const lo = box.min[axis];
      const hi = box.max[axis];
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new Error(`StaticWorld: box "${box.id}" has a non-finite ${axis} bound`);
      }
      if (hi < lo) {
        throw new Error(`StaticWorld: box "${box.id}" has max.${axis} < min.${axis}`);
      }
    }
  }
}

/**
 * Slab test for a segment (a → b) against one AABB.
 *
 * Returns true if the segment enters the box at any point in [0, 1]. A ray that
 * runs parallel to and outside a slab is rejected on that axis. The small
 * epsilon keeps a segment that grazes a face from flickering between hit and
 * miss under floating point.
 */
export function segmentIntersectsBox(a: Vec3, b: Vec3, box: StaticBox): boolean {
  let tMin = 0;
  let tMax = 1;
  const EPS = 1e-9;

  // x axis
  {
    const d = b.x - a.x;
    if (Math.abs(d) < EPS) {
      if (a.x < box.min.x || a.x > box.max.x) return false;
    } else {
      const inv = 1 / d;
      let t1 = (box.min.x - a.x) * inv;
      let t2 = (box.max.x - a.x) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return false;
    }
  }
  // y axis
  {
    const d = b.y - a.y;
    if (Math.abs(d) < EPS) {
      if (a.y < box.min.y || a.y > box.max.y) return false;
    } else {
      const inv = 1 / d;
      let t1 = (box.min.y - a.y) * inv;
      let t2 = (box.max.y - a.y) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return false;
    }
  }
  // z axis
  {
    const d = b.z - a.z;
    if (Math.abs(d) < EPS) {
      if (a.z < box.min.z || a.z > box.max.z) return false;
    } else {
      const inv = 1 / d;
      let t1 = (box.min.z - a.z) * inv;
      let t2 = (box.max.z - a.z) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return false;
    }
  }
  return true;
}

/**
 * True when nothing in the world blocks the segment from `from` to `to`.
 * `ignoreId` lets a cover box exclude itself when reasoning about peeking out.
 */
export function lineOfSightClear(
  world: StaticWorld,
  from: Vec3,
  to: Vec3,
  ignoreId?: string,
): boolean {
  const boxes = world.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (ignoreId !== undefined && box.id === ignoreId) continue;
    if (segmentIntersectsBox(from, to, box)) return false;
  }
  return true;
}

export function boxCenter(box: StaticBox, out: Vec3): Vec3 {
  out.x = (box.min.x + box.max.x) * 0.5;
  out.y = (box.min.y + box.max.y) * 0.5;
  out.z = (box.min.z + box.max.z) * 0.5;
  return out;
}

/** Convenience constructor: a box from a centre and half-extents. */
export function boxFromCenter(id: string, cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number): StaticBox {
  return {
    id,
    min: { x: cx - hx, y: cy - hy, z: cz - hz },
    max: { x: cx + hx, y: cy + hy, z: cz + hz },
  };
}

export interface ArenaCover {
  id: string;
  /** Centre of the box. */
  center: Vec3;
  /** Half-extents. */
  half: Vec3;
}

export interface Arena {
  world: StaticWorld;
  cover: ArenaCover[];
  /** Ground plane is at y = 0; the play area spans this half-extent in XZ. */
  halfExtent: number;
}

/**
 * The one arena definition, shared by the renderer and the evidence.
 *
 * A small box arena (issue #32 point 2), laid out so the default scenario can
 * drive every state deterministically:
 *
 *  - The enemy holds near the back (≈ z −6) facing +Z down an open central lane.
 *  - `pillar-c` sits on that lane near the entrance (z +4.2): the player emerges
 *    from behind it to be spotted and can retreat behind it to break sight.
 *  - `hide-l` / `hide-r` are chest-high blocks the player ducks behind to force
 *    a lost-sight → search, at head height for the sight ray.
 *  - `cover-l` / `cover-r` are the enemy's two cover stances, far enough apart
 *    that a reposition between them is a visible move, not a shuffle.
 *  - `wall-back` closes the space behind the enemy.
 *
 * Boxes are procedural primitives — no external asset, nothing copyrighted.
 */
export function buildArena(): Arena {
  const cover: ArenaCover[] = [
    { id: 'wall-back', center: { x: 0, y: 1.1, z: -8.6 }, half: { x: 4.5, y: 1.1, z: 0.3 } },
    { id: 'cover-l', center: { x: -3.2, y: 0.6, z: -3.4 }, half: { x: 0.7, y: 0.6, z: 0.7 } },
    { id: 'cover-r', center: { x: 3.2, y: 0.6, z: -3.4 }, half: { x: 0.7, y: 0.6, z: 0.7 } },
    { id: 'hide-l', center: { x: -2.6, y: 0.9, z: 0.6 }, half: { x: 0.8, y: 0.9, z: 0.8 } },
    { id: 'hide-r', center: { x: 2.6, y: 0.9, z: 0.6 }, half: { x: 0.8, y: 0.9, z: 0.8 } },
    { id: 'pillar-c', center: { x: 0, y: 1.3, z: 4.2 }, half: { x: 0.6, y: 1.3, z: 0.6 } },
  ];
  const world: StaticWorld = {
    boxes: cover.map((c) => boxFromCenter(
      c.id, c.center.x, c.center.y, c.center.z, c.half.x, c.half.y, c.half.z,
    )),
  };
  assertValidStaticWorld(world);
  return { world, cover, halfExtent: 10 };
}

/** The enemy's home stance and facing for the shared arena. */
export const ARENA_ENEMY_SPAWN: Vec3 = { x: 0, y: 0, z: -6 };
/** yaw = π faces +Z, down the lane toward the player entrance. */
export const ARENA_ENEMY_YAW = Math.PI;
