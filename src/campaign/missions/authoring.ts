/**
 * Shared, browser-free authoring helpers for campaign-owned mission arenas.
 *
 * Missions 2–3 (Relay, Foundry) each ship their own level factory; the seven
 * new campaign missions (orders 4–10) do NOT get a bespoke level branch, so they
 * author their `ArenaDefinition` directly here. To keep every one of them honest
 * — the same one-source, box-world discipline `src/level/arena.ts` enforces —
 * this module hands out the exact same primitives (`box`, `onFloor`) plus a few
 * higher-level builders (`floorSlab`, `perimeter`) and, crucially, a pair of
 * *validators* (`assertClearFloor`, `assertCover`) a mission calls on its own
 * spawns/enemies so a bad coordinate throws at `createArena()` time with a
 * pointed message, long before the catalog's generic clearance check runs.
 *
 * Nothing here imports `three` or the DOM: an arena built with these helpers is
 * pure data the campaign catalog can validate in Node, identically to the
 * shipping cargo bay.
 */

import type {
  ArenaDefinition,
  LightSpec,
  MaterialKey,
  ShotSpec,
  Solid,
  SurfaceMaterial,
  Vec3,
} from '../../level/arena.js';
import { deriveClearFloorSpawn, isSpawnClear, standsOnFloor } from '../spawns.js';
import { asMissionId } from '../ids.js';
import type {
  CheckpointPolicy,
  CompletionPolicy,
  EnemyPlacement,
  FailurePolicy,
  MissionDefinition,
  MissionObjective,
  MissionVisualMetadata,
  SpawnSlot,
} from '../types.js';

export type { ArenaDefinition, LightSpec, ShotSpec, Solid, Vec3 } from '../../level/arena.js';

type BoxOpts = Partial<Pick<Solid, 'collide' | 'castShadow' | 'receiveShadow' | 'tint'>>;

/** One axis-aligned box from a centre + size — the unit of every arena. */
export function box(
  id: string,
  center: Vec3,
  size: Vec3,
  material: MaterialKey,
  surface: SurfaceMaterial,
  opts: BoxOpts = {},
): Solid {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  return {
    id,
    min: [cx - hx, cy - hy, cz - hz],
    max: [cx + hx, cy + hy, cz + hz],
    material,
    surface,
    collide: opts.collide ?? true,
    castShadow: opts.castShadow ?? true,
    receiveShadow: opts.receiveShadow ?? true,
    tint: opts.tint,
  };
}

/** A box resting ON the floor: base at y=0, height grows upward. */
export function onFloor(
  id: string,
  centerXZ: readonly [number, number],
  footprint: readonly [number, number],
  height: number,
  material: MaterialKey,
  surface: SurfaceMaterial,
  opts: BoxOpts = {},
): Solid {
  const [cx, cz] = centerXZ;
  const [w, d] = footprint;
  return box(id, [cx, height / 2, cz], [w, height, d], material, surface, opts);
}

export interface RoomBounds {
  /** Interior play bounds (inner faces of the walls). */
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
}

/**
 * The ground slab under a rectangular room. Its top face sits at y=0 (so a floor
 * spawn has `position[1] === 0`) and it extends `WALL_T` past the interior on
 * every side so there is no seam at the perimeter walls.
 */
export const WALL_T = 0.6;
const FLOOR_DROP = 0.6;

export function floorSlab(bounds: RoomBounds, material: MaterialKey = 'concrete'): Solid {
  const { xMin, xMax, zMin, zMax } = bounds;
  return box(
    'floor',
    [(xMin + xMax) / 2, -FLOOR_DROP / 2, (zMin + zMax) / 2],
    [(xMax - xMin) + WALL_T * 2, FLOOR_DROP, (zMax - zMin) + WALL_T * 2],
    material,
    material === 'wood' ? 'wood' : 'concrete',
    { castShadow: false },
  );
}

export interface PerimeterOpts {
  readonly northTop?: number;
  readonly sideTop?: number;
  readonly southTop?: number;
  readonly material?: MaterialKey;
  readonly surface?: SurfaceMaterial;
  readonly tint?: number;
}

/**
 * Four solid perimeter walls around a rectangular room, ids
 * `wall-n`/`wall-s`/`wall-w`/`wall-e`. Heights default to a tall north backdrop
 * with lower flanks so the sky reads over them and the silhouette varies.
 */
export function perimeter(bounds: RoomBounds, opts: PerimeterOpts = {}): Solid[] {
  const { xMin, xMax, zMin, zMax } = bounds;
  const northTop = opts.northTop ?? 6.0;
  const sideTop = opts.sideTop ?? 3.6;
  const southTop = opts.southTop ?? 3.2;
  const mat = opts.material ?? 'concrete';
  const surf = opts.surface ?? 'concrete';
  const span = (xMax - xMin) + WALL_T * 2;
  const wallOpts: BoxOpts = { tint: opts.tint };
  return [
    onFloor('wall-n', [(xMin + xMax) / 2, zMin - WALL_T / 2], [span, WALL_T], northTop, mat, surf, wallOpts),
    onFloor('wall-s', [(xMin + xMax) / 2, zMax + WALL_T / 2], [span, WALL_T], southTop, mat, surf, wallOpts),
    onFloor('wall-w', [xMin - WALL_T / 2, (zMin + zMax) / 2], [WALL_T, (zMax - zMin)], sideTop, mat, surf, wallOpts),
    onFloor('wall-e', [xMax + WALL_T / 2, (zMin + zMax) / 2], [WALL_T, (zMax - zMin)], sideTop, mat, surf, wallOpts),
  ];
}

/**
 * Assert a feet point stands on clear floor for the standing player capsule.
 * Throws a pointed error naming the offending point — a mission that miscomputes
 * a spawn or an enemy hold fails loudly at `createArena()` rather than producing
 * a subtly-embedded body the catalog rejects with a generic message.
 */
export function assertClearFloor(point: Vec3, solids: readonly Solid[], label: string): Vec3 {
  if (Math.abs(point[1]) > 0.02) {
    throw new Error(`${label}: point ${JSON.stringify(point)} is not a floor point (y must be 0)`);
  }
  if (!standsOnFloor(point, solids)) {
    throw new Error(`${label}: no floor slab beneath ${JSON.stringify(point)}`);
  }
  if (!isSpawnClear(point, solids, { radius: 0.34, height: 1.78 })) {
    throw new Error(`${label}: standing capsule is obstructed at ${JSON.stringify(point)}`);
  }
  return point;
}

/** Assert every named cover id exists AND collides (matches the catalog rule). */
export function assertCover(coverIds: readonly string[], solids: readonly Solid[], label: string): readonly string[] {
  const byId = new Map(solids.map((s) => [s.id, s]));
  if (coverIds.length < 2) {
    throw new Error(`${label}: at least two cover ids are required, got ${coverIds.length}`);
  }
  for (const id of coverIds) {
    const solid = byId.get(id);
    if (!solid) throw new Error(`${label}: cover id "${id}" names no solid`);
    if (!solid.collide) throw new Error(`${label}: cover id "${id}" does not collide`);
  }
  return coverIds;
}

/**
 * Weathered tint palette (packed 0xRRGGBB, applied as a linear-space vertex
 * colour). Shared so the seven new missions can each carry a distinct silhouette
 * colour over the same procedural material library — atmosphere by palette and
 * light, never by inventing a new material the renderer cannot honour.
 */
export const TINT = {
  harbourBlue: 0x2f4a57,
  oxideRust: 0x7a4030,
  fadedTeal: 0x36564f,
  ochre: 0x8a6a2f,
  slateGrey: 0x49555a,
  mossGreen: 0x3c5138,
  paleIce: 0x6f8697,
  sodiumAmber: 0x7d5a2c,
  emberRed: 0x6e2f28,
  nightCyan: 0x2c5560,
  bone: 0x8a8577,
  deepPlum: 0x40354f,
} as const;

export interface MissionSpec {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly brief: string;
  readonly objective: MissionObjective;
  /** The arena factory — called once here to derive/validate the secondary spawn. */
  readonly createArena: () => ArenaDefinition;
  /** Primary insertion label; the secondary is derived clearance-proven. */
  readonly primarySpawnLabel?: string;
  /** Deterministic tactical offsets for the derived secondary spawn (XZ). */
  readonly secondarySpawnOffsets?: readonly (readonly [number, number])[];
  readonly enemies: readonly EnemyPlacement[];
  /** Defaults to the enemy count (whole roster must fall). */
  readonly requiredEliminations?: number;
  readonly retryFrom?: FailurePolicy['retryFrom'];
  readonly banksOnElimination?: boolean;
  readonly visual?: MissionVisualMetadata;
}

/**
 * Assemble a `MissionDefinition` from a spec, deriving the mandatory second
 * insertion slot from the *real* arena geometry (never a hand-typed literal) via
 * the same `deriveClearFloorSpawn` the shipping cargo bay uses. The result is
 * plain data the catalog re-validates against the arena `createArena` builds.
 */
export function defineMission(spec: MissionSpec): MissionDefinition {
  const arena = spec.createArena();
  const primary = arena.playerSpawn;
  const derived = deriveClearFloorSpawn(arena, primary, {
    avoid: [primary],
    minSeparation: 2.5,
    preferredOffsets: spec.secondarySpawnOffsets,
  });
  const spawnA: SpawnSlot = {
    id: 'insertion-primary',
    label: spec.primarySpawnLabel ?? 'Primary insertion',
    position: primary,
    yaw: 0,
  };
  const spawnB: SpawnSlot = {
    id: 'insertion-secondary',
    label: 'Secondary insertion (derived, clearance-proven)',
    position: derived.position,
    yaw: 0,
  };
  const completion: CompletionPolicy = {
    kind: 'eliminate-all-enemies',
    requiredEliminations: spec.requiredEliminations ?? spec.enemies.length,
  };
  const failure: FailurePolicy = {
    kind: 'player-death',
    retryFrom: spec.retryFrom ?? 'mission-start',
  };
  const checkpoint: CheckpointPolicy = {
    initial: 'mission-start',
    banksOnElimination: spec.banksOnElimination ?? false,
  };
  return {
    id: asMissionId(spec.id),
    order: spec.order,
    title: spec.title,
    brief: spec.brief,
    objective: spec.objective,
    createArena: spec.createArena,
    playerSpawns: [spawnA, spawnB],
    enemies: spec.enemies,
    completion,
    failure,
    checkpoint,
    visual: spec.visual,
  };
}

/** Compute a facing yaw so an enemy at `from` looks toward `to` (0 = −Z). */
export function faceToward(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], -(to[2] - from[2]));
}

/** Assemble a validated arena record from its parts (a thin, typed convenience). */
export function makeArena(parts: {
  solids: readonly Solid[];
  lights: readonly LightSpec[];
  shots: readonly ShotSpec[];
  playerSpawn: Vec3;
  enemySpawn: Vec3;
  enemyCoverIds: readonly string[];
  fog: { color: number; density: number };
}): ArenaDefinition {
  return {
    solids: parts.solids,
    lights: parts.lights,
    shots: parts.shots,
    playerSpawn: parts.playerSpawn,
    enemySpawn: parts.enemySpawn,
    enemyCoverIds: parts.enemyCoverIds,
    fog: parts.fog,
  };
}
