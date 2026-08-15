/**
 * Campaign-owned arena authoring helpers.
 *
 * Missions 2 and 3 need their own `ArenaDefinition`s, but the shipping level's
 * `box`/`onFloor` helpers in `arena.ts` are private and — per this work's
 * boundary — must not be touched. So the campaign authors arenas with its own
 * small, equivalent helpers here. They emit the *same* `Solid`/`ArenaDefinition`
 * shape the level already exports, so a campaign arena is indistinguishable from
 * `buildArena()`'s output to every downstream consumer (correspondence proof,
 * static world, AI binding). Pure data, no `three`, no DOM.
 *
 * The one honesty rule inherited from `arena.ts` holds here too: anything that
 * reads as body-height cover collides; render-only dressing sets `collide:false`
 * and is never listed as cover.
 */

import type {
  ArenaDefinition,
  LightSpec,
  MaterialKey,
  ShotSpec,
  Solid,
  SurfaceMaterial,
  Vec3,
} from '../level/arena.js';

type SolidOpts = Partial<Pick<Solid, 'collide' | 'castShadow' | 'receiveShadow' | 'tint'>>;

/** An axis-aligned box from a centre and full size. */
export function box(
  id: string,
  center: Vec3,
  size: Vec3,
  material: MaterialKey,
  surface: SurfaceMaterial,
  opts: SolidOpts = {},
): Solid {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size;
  return {
    id,
    min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
    max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
    material,
    surface,
    collide: opts.collide ?? true,
    castShadow: opts.castShadow ?? true,
    receiveShadow: opts.receiveShadow ?? true,
    tint: opts.tint,
  };
}

/** A box resting ON the floor: base at y=0, growing upward by `height`. */
export function onFloor(
  id: string,
  centerXZ: readonly [number, number],
  footprint: readonly [number, number],
  height: number,
  material: MaterialKey,
  surface: SurfaceMaterial,
  opts: SolidOpts = {},
): Solid {
  const [cx, cz] = centerXZ;
  const [w, d] = footprint;
  return box(id, [cx, height / 2, cz], [w, height, d], material, surface, opts);
}

export interface RoomShellOptions {
  /** Interior X extents (inner faces of the E/W walls). */
  readonly x: readonly [number, number];
  /** Interior Z extents (inner faces of the N/S walls). */
  readonly z: readonly [number, number];
  readonly wallHeight: number;
  readonly wallThickness?: number;
  readonly floorDrop?: number;
  readonly floorMaterial?: MaterialKey;
  readonly floorSurface?: SurfaceMaterial;
  readonly wallMaterial?: MaterialKey;
}

/**
 * Emit a rectangular room: one floor slab (top at y=0, extended under the walls
 * so there is no perimeter seam) and four perimeter walls. The floor slab
 * satisfies `spawns.isFloorSlab`, so any interior feet point stands on floor.
 */
export function roomShell(opts: RoomShellOptions): Solid[] {
  const [xMin, xMax] = opts.x;
  const [zMin, zMax] = opts.z;
  const t = opts.wallThickness ?? 0.6;
  const drop = opts.floorDrop ?? 0.6;
  const floorMat = opts.floorMaterial ?? 'concrete';
  const floorSurf = opts.floorSurface ?? 'concrete';
  const wallMat = opts.wallMaterial ?? 'concrete';
  const span = (xMax - xMin) + t * 2;

  return [
    box(
      'floor',
      [(xMin + xMax) / 2, -drop / 2, (zMin + zMax) / 2],
      [span, drop, (zMax - zMin) + t * 2],
      floorMat,
      floorSurf,
      { castShadow: false },
    ),
    onFloor('wall-n', [(xMin + xMax) / 2, zMin - t / 2], [span, t], opts.wallHeight, wallMat, 'concrete'),
    onFloor('wall-s', [(xMin + xMax) / 2, zMax + t / 2], [span, t], opts.wallHeight, wallMat, 'concrete'),
    onFloor('wall-w', [xMin - t / 2, (zMin + zMax) / 2], [t, (zMax - zMin)], opts.wallHeight, wallMat, 'concrete'),
    onFloor('wall-e', [xMax + t / 2, (zMin + zMax) / 2], [t, (zMax - zMin)], opts.wallHeight, wallMat, 'concrete'),
  ];
}

export interface ArenaBuildInput {
  readonly solids: readonly Solid[];
  readonly lights: readonly LightSpec[];
  readonly shots: readonly ShotSpec[];
  readonly playerSpawn: Vec3;
  readonly enemySpawn: Vec3;
  readonly enemyCoverIds: readonly string[];
  readonly fog: { readonly color: number; readonly density: number };
}

/** Assemble an `ArenaDefinition` from parts, guarding against duplicate solid ids. */
export function assembleArena(input: ArenaBuildInput): ArenaDefinition {
  const seen = new Set<string>();
  for (const solid of input.solids) {
    if (seen.has(solid.id)) {
      throw new Error(`assembleArena: duplicate solid id "${solid.id}"`);
    }
    seen.add(solid.id);
  }
  return {
    solids: input.solids,
    lights: input.lights,
    shots: input.shots,
    playerSpawn: input.playerSpawn,
    enemySpawn: input.enemySpawn,
    enemyCoverIds: input.enemyCoverIds,
    fog: input.fog,
  };
}
