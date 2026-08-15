/**
 * Axis-aligned static collision solver for the vertical slice (#36, parent #32).
 *
 * The world is ONLY axis-aligned boxes (`StaticWorld`). Against that contract a
 * capsule sweep is exact and cheap: every floor normal is +Y, every wall normal
 * is horizontal, and there is no closest-point-on-triangle to get subtly wrong.
 * This is the deliberate replacement for PR #3/#13's `StaticCollisionWorld`,
 * whose mesh/BVH capsule solver throws the body upward by >100 mm in a single
 * tick on a finite ramp it rates walkable (the committed fixture reproduces
 * 116–154 mm pops; the original review reported 45–57 mm — see
 * `fixtures/finite-ramp-defect.mjs`). Here a ramp cannot even be expressed, so
 * the unverified path is unreachable, not untested.
 *
 * `fromStaticWorld` runs `assertValidStaticWorld`, so a degenerate,
 * out-of-bounds — or, by construction, non-axis-aligned — world throws at
 * registration rather than degrading silently.
 *
 * The player is a vertical capsule: a segment from feet+radius to
 * feet+height-radius, swept with `radius`. `moveCapsule` moves it by a
 * displacement, resolving penetration (which yields wall sliding for free),
 * traversing steps up to `maxStepHeight`, and snapping to ground within
 * `groundSnapDistance` so a walker stays glued to flat floors and descends
 * steps without a one-tick fall.
 */

import * as THREE from 'three';
import type { SurfaceKind } from '../core/contracts.js';
import {
  assertValidStaticWorld,
  type StaticWorld,
  type Vec3,
} from '../core/collision.js';

const EPSILON = 1e-5;
const MAX_RESOLVE_ITERATIONS = 4;
/** No substep may advance more than this fraction of the radius, so a fast fall
 *  cannot tunnel a thin solid between ticks. */
const MAX_SUBSTEP_FRACTION = 0.5;
/** How far ABOVE the feet the ground snap may re-grab a support. A walker at a
 *  step edge sinks a couple of millimetres below the tread it is leaving (the
 *  edge's diagonal distance briefly exceeds the radius, so the vertical resolve
 *  cannot re-lift it); without this tolerance that tread falls out of the snap
 *  window and the walker goes airborne beside the riser. Kept far below a real
 *  step so it never climbs one — that is the step solver's job. */
const GROUND_REGRAB_TOLERANCE = 0.06;

export interface CapsuleContact {
  /** Unit push-out direction, from the solid toward the capsule. */
  readonly normal: THREE.Vector3;
  /** Penetration removed along the normal, metres. */
  readonly depth: number;
  readonly surface: SurfaceKind;
}

export interface CapsuleMoveOptions {
  height: number;
  radius: number;
  displacement: THREE.Vector3;
  wasGrounded: boolean;
  /** Eligible for downward ground snap: grounded within the coyote window and
   *  not mid-jump. Kept separate from `wasGrounded` so a single airborne tick at
   *  a step edge does not disable the snap and drop the walker into a free-fall. */
  snapGrounded: boolean;
  maxStepHeight: number;
  groundSnapDistance: number;
  /** Minimum contact normal Y that counts as standing ground. */
  minGroundNormalY: number;
}

export interface CapsuleMoveResult {
  position: THREE.Vector3;
  actualDisplacement: THREE.Vector3;
  contacts: CapsuleContact[];
  grounded: boolean;
  hitCeiling: boolean;
  hitWall: boolean;
  steppedHeight: number;
  /** Metres the ground snap lowered the feet this tick (a step-down). The eye
   *  is offset by this and decayed so a descended riser reads as a glide. */
  steppedDown: number;
  surface: SurfaceKind;
}

interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  surface: SurfaceKind;
}

interface Support {
  height: number;
  surface: SurfaceKind;
}

/** Closest-feature result between the vertical capsule axis and one box. */
interface Nearest {
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number;
  inside: boolean;
}

export class StaticBoxWorld {
  private readonly boxes: Box[];
  private readonly bounds: { min: Vec3; max: Vec3 };

  private readonly nearest: Nearest = {
    px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, inside: false,
  };

  private constructor(boxes: Box[], bounds: { min: Vec3; max: Vec3 }) {
    this.boxes = boxes;
    this.bounds = bounds;
  }

  /**
   * Builds a solver from a validated static world. This is the registration
   * guard: `assertValidStaticWorld` throws on any box that is degenerate or
   * escapes bounds, which is what keeps the unverified slope path unreachable.
   */
  static fromStaticWorld(world: StaticWorld): StaticBoxWorld {
    assertValidStaticWorld(world);
    const boxes: Box[] = world.boxes.map((box) => ({
      minX: box.min[0], minY: box.min[1], minZ: box.min[2],
      maxX: box.max[0], maxY: box.max[1], maxZ: box.max[2],
      surface: box.material,
    }));
    return new StaticBoxWorld(boxes, {
      min: world.bounds.min,
      max: world.bounds.max,
    });
  }

  moveCapsule(position: THREE.Vector3, options: CapsuleMoveOptions): CapsuleMoveResult {
    const { height, radius } = options;
    const start = position.clone();
    const pos = position.clone();
    const contacts: CapsuleContact[] = [];

    // 1) Vertical, then horizontal — kept distinct so a wall never eats the
    //    fall and a floor never eats forward motion.
    this.sweep(pos, 0, options.displacement.y, 0, height, radius, contacts);
    const verticalGrounded = hasGround(contacts, options.minGroundNormalY);

    const beforeHoriz = pos.clone();
    const hx = options.displacement.x;
    const hz = options.displacement.z;
    const horizLength = Math.hypot(hx, hz);
    const directContacts: CapsuleContact[] = [];
    this.sweep(pos, hx, 0, hz, height, radius, directContacts);

    let steppedHeight = 0;
    if (
      options.wasGrounded
      && options.maxStepHeight > 0
      && horizLength > EPSILON
      && horizontalProgress(beforeHoriz, pos, hx, hz) < horizLength * 0.8
    ) {
      const stepped = this.tryStep(beforeHoriz, hx, hz, options);
      if (
        stepped
        && horizontalProgress(beforeHoriz, stepped.position, hx, hz)
          > horizontalProgress(beforeHoriz, pos, hx, hz) + EPSILON
      ) {
        pos.copy(stepped.position);
        directContacts.length = 0;
        directContacts.push(...stepped.contacts);
        steppedHeight = Math.max(0, pos.y - beforeHoriz.y);
      }
    }
    contacts.push(...directContacts);

    // 2) Ground snap. Only downward: a jumping tick (displacement.y > 0) must be
    //    allowed to leave the floor. This is what keeps a walker glued to a flat
    //    floor (where a zero-Y move produces no penetration contact) and lets it
    //    descend a step without a one-tick fall. It is gated on `snapGrounded`
    //    (a coyote window), not the last tick's grounded flag, because the
    //    closest feature at a step edge is the horizontal lip and its diagonal
    //    distance briefly exceeds the radius — one such tick must not cancel the
    //    snap and drop the walker into a free-fall down the riser.
    let grounded = hasGround(contacts, options.minGroundNormalY) || verticalGrounded;
    let steppedDown = 0;
    if (options.snapGrounded && options.displacement.y <= 0 && options.groundSnapDistance > 0) {
      const support = this.highestSupportUnder(
        pos.x, pos.z, radius,
        pos.y - options.groundSnapDistance, pos.y + GROUND_REGRAB_TOLERANCE,
      );
      if (
        support
        && support.height <= pos.y + GROUND_REGRAB_TOLERANCE
        && this.fits(pos.x, support.height, pos.z, height, radius)
      ) {
        steppedDown = Math.max(0, pos.y - support.height);
        pos.y = support.height;
        contacts.push({ normal: new THREE.Vector3(0, 1, 0), depth: 0, surface: support.surface });
        grounded = true;
      }
    }

    this.clampToBounds(pos, radius);

    const hitCeiling = contacts.some((c) => c.normal.y < -0.5);
    const hitWall = contacts.some((c) => Math.abs(c.normal.y) < options.minGroundNormalY);
    const groundContact = contacts
      .filter((c) => c.normal.y >= options.minGroundNormalY)
      .sort((a, b) => b.normal.y - a.normal.y)[0];

    return {
      position: pos,
      actualDisplacement: pos.clone().sub(start),
      contacts,
      grounded,
      hitCeiling,
      hitWall,
      steppedHeight,
      steppedDown,
      surface: groundContact?.surface ?? 'concrete',
    };
  }

  /** True when the capsule at `position` overlaps no solid. */
  canFit(position: THREE.Vector3, height: number, radius: number): boolean {
    return this.fits(position.x, position.y, position.z, height, radius);
  }

  private sweep(
    pos: THREE.Vector3,
    dx: number, dy: number, dz: number,
    height: number, radius: number,
    out: CapsuleContact[],
  ): void {
    const dist = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(dist / (radius * MAX_SUBSTEP_FRACTION)));
    const sx = dx / steps;
    const sy = dy / steps;
    const sz = dz / steps;
    for (let i = 0; i < steps; i++) {
      pos.x += sx;
      pos.y += sy;
      pos.z += sz;
      this.resolve(pos, height, radius, out);
    }
  }

  /** Depenetrates the capsule at `pos` against every box, appending contacts. */
  private resolve(pos: THREE.Vector3, height: number, radius: number, out: CapsuleContact[]): void {
    for (let iteration = 0; iteration < MAX_RESOLVE_ITERATIONS; iteration++) {
      let corrected = false;
      const ay = pos.y + radius;
      const by = pos.y + Math.max(radius, height - radius);
      for (const box of this.boxes) {
        this.closest(box, pos.x, ay, by, pos.z);
        const n = this.nearest;
        let nx: number; let ny: number; let nz: number; let depth: number;
        if (n.inside) {
          // Axis line inside the box: push out through the least-penetrated face.
          const pen = faceEscape(box, n.px, n.py, n.pz);
          nx = pen.nx; ny = pen.ny; nz = pen.nz;
          depth = pen.distance + radius;
        } else {
          const ex = n.px - n.qx;
          const ey = n.py - n.qy;
          const ez = n.pz - n.qz;
          const d = Math.hypot(ex, ey, ez);
          if (d >= radius - EPSILON) continue;
          const inv = d > EPSILON ? 1 / d : 0;
          nx = ex * inv; ny = ey * inv; nz = ez * inv;
          depth = radius - d;
        }
        pos.x += nx * depth;
        pos.y += ny * depth;
        pos.z += nz * depth;
        out.push({ normal: new THREE.Vector3(nx, ny, nz), depth, surface: box.surface });
        corrected = true;
      }
      if (!corrected) break;
    }
  }

  private tryStep(
    before: THREE.Vector3,
    hx: number, hz: number,
    options: CapsuleMoveOptions,
  ): { position: THREE.Vector3; contacts: CapsuleContact[] } | null {
    const { height, radius, maxStepHeight } = options;
    const raised = before.clone();
    raised.y += maxStepHeight + EPSILON;
    if (!this.canFit(raised, height, radius)) return null;

    const contacts: CapsuleContact[] = [];
    this.sweep(raised, hx, 0, hz, height, radius, contacts);

    const support = this.highestSupportUnder(
      raised.x, raised.z, radius,
      before.y + EPSILON, before.y + maxStepHeight + EPSILON,
    );
    if (!support) return null;

    raised.y = support.height;
    if (!this.canFit(raised, height, radius)) return null;
    contacts.push({ normal: new THREE.Vector3(0, 1, 0), depth: 0, surface: support.surface });
    return { position: raised, contacts };
  }

  /**
   * Highest box top whose XZ face lies under the capsule footprint and whose
   * height is within [minY, maxY]. This is the only surface query the walker
   * needs, because in a box world the only walkable surface is a box top.
   */
  private highestSupportUnder(
    x: number, z: number, radius: number,
    minY: number, maxY: number,
  ): Support | null {
    let best: Support | null = null;
    const r2 = radius * radius;
    for (const box of this.boxes) {
      if (box.maxY < minY || box.maxY > maxY) continue;
      const cx = clamp(x, box.minX, box.maxX);
      const cz = clamp(z, box.minZ, box.maxZ);
      const ddx = x - cx;
      const ddz = z - cz;
      if (ddx * ddx + ddz * ddz > r2) continue;
      if (!best || box.maxY > best.height) {
        best = { height: box.maxY, surface: box.surface };
      }
    }
    return best;
  }

  private fits(x: number, y: number, z: number, height: number, radius: number): boolean {
    const ay = y + radius;
    const by = y + Math.max(radius, height - radius);
    for (const box of this.boxes) {
      this.closest(box, x, ay, by, z);
      const n = this.nearest;
      if (n.inside) return false;
      const ex = n.px - n.qx;
      const ey = n.py - n.qy;
      const ez = n.pz - n.qz;
      if (ex * ex + ey * ey + ez * ez < (radius - EPSILON) * (radius - EPSILON)) return false;
    }
    return true;
  }

  /** Closest points between the vertical axis segment [ay,by] at (x,z) and a box. */
  private closest(box: Box, x: number, ay: number, by: number, z: number): void {
    const n = this.nearest;
    const qx = clamp(x, box.minX, box.maxX);
    const qz = clamp(z, box.minZ, box.maxZ);
    let py: number;
    let qy: number;
    if (by < box.minY) {
      py = by; qy = box.minY;
    } else if (ay > box.maxY) {
      py = ay; qy = box.maxY;
    } else {
      py = clamp((box.minY + box.maxY) * 0.5, ay, by);
      qy = clamp(py, box.minY, box.maxY);
    }
    n.px = x; n.py = py; n.pz = z;
    n.qx = qx; n.qy = qy; n.qz = qz;
    n.inside = x > box.minX && x < box.maxX
      && z > box.minZ && z < box.maxZ
      && py > box.minY && py < box.maxY;
  }

  private clampToBounds(pos: THREE.Vector3, radius: number): void {
    const min = this.bounds.min;
    const max = this.bounds.max;
    pos.x = clamp(pos.x, min[0] + radius, max[0] - radius);
    pos.z = clamp(pos.z, min[2] + radius, max[2] - radius);
    if (pos.y < min[1]) pos.y = min[1];
  }
}

interface FaceEscape { nx: number; ny: number; nz: number; distance: number }

/** Least-penetration escape for a point known to be inside the box. */
function faceEscape(box: Box, px: number, py: number, pz: number): FaceEscape {
  const toMinX = px - box.minX;
  const toMaxX = box.maxX - px;
  const toMinY = py - box.minY;
  const toMaxY = box.maxY - py;
  const toMinZ = pz - box.minZ;
  const toMaxZ = box.maxZ - pz;
  let nx = 0; let ny = 1; let nz = 0;
  let distance = toMaxY;
  if (toMinX < distance) { distance = toMinX; nx = -1; ny = 0; nz = 0; }
  if (toMaxX < distance) { distance = toMaxX; nx = 1; ny = 0; nz = 0; }
  if (toMinY < distance) { distance = toMinY; nx = 0; ny = -1; nz = 0; }
  if (toMaxY < distance) { distance = toMaxY; nx = 0; ny = 1; nz = 0; }
  if (toMinZ < distance) { distance = toMinZ; nx = 0; ny = 0; nz = -1; }
  if (toMaxZ < distance) { distance = toMaxZ; nx = 0; ny = 0; nz = 1; }
  return { nx, ny, nz, distance };
}

function hasGround(contacts: CapsuleContact[], minNormalY: number): boolean {
  return contacts.some((c) => c.normal.y >= minNormalY);
}

function horizontalProgress(
  start: THREE.Vector3,
  end: THREE.Vector3,
  desiredX: number,
  desiredZ: number,
): number {
  const length = Math.hypot(desiredX, desiredZ);
  if (length <= EPSILON) return 0;
  return ((end.x - start.x) * desiredX + (end.z - start.z) * desiredZ) / length;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
