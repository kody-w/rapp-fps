/**
 * `createCampaignCatalog` — the validated gate every mission set passes through.
 *
 * Integration injects a `MissionDefinition[]`; the catalog refuses to hand back a
 * usable campaign unless the set is internally consistent AND agrees with the
 * *real geometry* each mission's `createArena` produces. Every rejection is a
 * typed `CampaignValidationError` with a machine-readable `code`, so a caller (or
 * a test's negative control) can assert exactly *why* a bad catalog was refused
 * rather than pattern-matching a message.
 *
 * What it proves, once, at construction:
 *  - ids are well-formed and unique; orders are a contiguous 1..N run (no dup, no gap);
 *  - every mission has exactly two floor-based spawns that stand clear of solids;
 *  - every objective carries a non-empty summary;
 *  - every mission has at least one defender, each with cover that actually collides;
 *  - completion counts are inside `[1, enemies.length]` — no unwinnable mission.
 *
 * The arenas are built once here and cached, so `createArena`'s cost is paid a
 * single time and downstream reads are pure lookups.
 */

import type { ArenaDefinition, Solid } from '../level/arena.js';
import type { MissionDefinition } from './types.js';
import type { MissionId } from './ids.js';
import { isMissionId } from './ids.js';
import { evaluateClearance, isSpawnClear, standsOnFloor, FLOOR_SURFACE_EPS } from './spawns.js';

export type CampaignValidationCode =
  | 'empty-catalog'
  | 'malformed-id'
  | 'duplicate-id'
  | 'duplicate-order'
  | 'non-contiguous-order'
  | 'invalid-arena'
  | 'insufficient-spawns'
  | 'spawn-not-floor'
  | 'spawn-obstructed'
  | 'duplicate-spawn'
  | 'missing-objective'
  | 'no-enemies'
  | 'missing-cover'
  | 'cover-not-collidable'
  | 'enemy-embedded'
  | 'invalid-progression';

export class CampaignValidationError extends Error {
  readonly code: CampaignValidationCode;
  readonly missionId?: string;
  constructor(code: CampaignValidationCode, message: string, missionId?: string) {
    super(message);
    this.name = 'CampaignValidationError';
    this.code = code;
    this.missionId = missionId;
  }
}

export interface CampaignCatalog {
  /** Missions sorted by ascending order. */
  readonly missions: readonly MissionDefinition[];
  /** Mission ids in order. */
  readonly ids: readonly MissionId[];
  readonly count: number;
  readonly firstMissionId: MissionId;
  byId(id: string): MissionDefinition | undefined;
  byOrder(order: number): MissionDefinition | undefined;
  has(id: string): boolean;
  /** The cached arena for a mission (built once at construction). */
  arenaFor(id: MissionId): ArenaDefinition;
  /** The next/previous mission by order, or `null` at an end. */
  nextMissionId(id: MissionId): MissionId | null;
  previousMissionId(id: MissionId): MissionId | null;
}

const MIN_SPAWN_SEPARATION = 0.5;

function requiredEliminations(mission: MissionDefinition): number {
  return mission.completion.requiredEliminations ?? mission.enemies.length;
}

function distanceXZ(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function solidById(arena: ArenaDefinition): Map<string, Solid> {
  const map = new Map<string, Solid>();
  for (const solid of arena.solids) map.set(solid.id, solid);
  return map;
}

function validateSpawns(mission: MissionDefinition, arena: ArenaDefinition): void {
  const spawns = mission.playerSpawns as ReadonlyArray<MissionDefinition['playerSpawns'][number]>;
  if (!Array.isArray(spawns) || spawns.length < 2) {
    throw new CampaignValidationError(
      'insufficient-spawns',
      `mission "${mission.id}" needs two spawn slots, has ${spawns?.length ?? 0}`,
      mission.id,
    );
  }
  for (const slot of spawns) {
    if (Math.abs(slot.position[1]) > FLOOR_SURFACE_EPS || !standsOnFloor(slot.position, arena.solids)) {
      throw new CampaignValidationError(
        'spawn-not-floor',
        `spawn "${slot.id}" in "${mission.id}" is not a floor point (y=${slot.position[1]})`,
        mission.id,
      );
    }
    const clearance = evaluateClearance(slot.position, arena.solids);
    if (!clearance.clear) {
      throw new CampaignValidationError(
        'spawn-obstructed',
        `spawn "${slot.id}" in "${mission.id}" is obstructed: ${clearance.reason}`,
        mission.id,
      );
    }
  }
  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      if (distanceXZ(spawns[i].position, spawns[j].position) < MIN_SPAWN_SEPARATION) {
        throw new CampaignValidationError(
          'duplicate-spawn',
          `spawns "${spawns[i].id}" and "${spawns[j].id}" in "${mission.id}" are the same point`,
          mission.id,
        );
      }
    }
  }
}

function validateObjective(mission: MissionDefinition): void {
  const summary = mission.objective?.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new CampaignValidationError(
      'missing-objective',
      `mission "${mission.id}" has no objective summary`,
      mission.id,
    );
  }
}

function validateEnemiesAndCover(mission: MissionDefinition, arena: ArenaDefinition): void {
  if (!Array.isArray(mission.enemies) || mission.enemies.length === 0) {
    throw new CampaignValidationError(
      'no-enemies',
      `mission "${mission.id}" declares no defenders`,
      mission.id,
    );
  }
  const solids = solidById(arena);
  for (const enemy of mission.enemies) {
    if (!Array.isArray(enemy.coverSolidIds) || enemy.coverSolidIds.length === 0) {
      throw new CampaignValidationError(
        'missing-cover',
        `defender "${enemy.id}" in "${mission.id}" has no cover`,
        mission.id,
      );
    }
    for (const coverId of enemy.coverSolidIds) {
      const solid = solids.get(coverId);
      if (!solid) {
        throw new CampaignValidationError(
          'cover-not-collidable',
          `cover id "${coverId}" for "${enemy.id}" in "${mission.id}" names no solid`,
          mission.id,
        );
      }
      if (!solid.collide) {
        throw new CampaignValidationError(
          'cover-not-collidable',
          `cover id "${coverId}" for "${enemy.id}" in "${mission.id}" does not collide`,
          mission.id,
        );
      }
    }
    // A defender embedded in a solid is as broken as an invisible collider.
    if (!standsOnFloor(enemy.spawn, arena.solids) || !isSpawnClear(enemy.spawn, arena.solids, { radius: 0.05 })) {
      throw new CampaignValidationError(
        'enemy-embedded',
        `defender "${enemy.id}" in "${mission.id}" is not on clear floor`,
        mission.id,
      );
    }
  }
}

function validateProgression(mission: MissionDefinition): void {
  if (!Number.isInteger(mission.order) || mission.order < 1) {
    throw new CampaignValidationError(
      'invalid-progression',
      `mission "${mission.id}" order ${mission.order} is not a positive integer`,
      mission.id,
    );
  }
  const req = requiredEliminations(mission);
  if (!Number.isInteger(req) || req < 1 || req > mission.enemies.length) {
    throw new CampaignValidationError(
      'invalid-progression',
      `mission "${mission.id}" requiredEliminations ${req} is outside [1, ${mission.enemies.length}]`,
      mission.id,
    );
  }
}

function buildArenaSafely(mission: MissionDefinition): ArenaDefinition {
  let arena: ArenaDefinition;
  try {
    arena = mission.createArena();
  } catch (err) {
    throw new CampaignValidationError(
      'invalid-arena',
      `mission "${mission.id}" createArena threw: ${(err as Error).message}`,
      mission.id,
    );
  }
  if (!arena || !Array.isArray(arena.solids) || arena.solids.length === 0) {
    throw new CampaignValidationError(
      'invalid-arena',
      `mission "${mission.id}" createArena produced no solids`,
      mission.id,
    );
  }
  return arena;
}

/**
 * Validate the injected missions and return an immutable, ordered catalog.
 * Throws `CampaignValidationError` on the first structural or geometric fault.
 */
export function createCampaignCatalog(missions: readonly MissionDefinition[]): CampaignCatalog {
  if (!Array.isArray(missions) || missions.length === 0) {
    throw new CampaignValidationError('empty-catalog', 'a campaign needs at least one mission');
  }

  const ids = new Set<string>();
  const orders = new Set<number>();
  const arenas = new Map<string, ArenaDefinition>();

  for (const mission of missions) {
    if (typeof mission.id !== 'string' || !isMissionId(mission.id)) {
      throw new CampaignValidationError(
        'malformed-id',
        `mission id ${JSON.stringify(mission.id)} is not kebab-case`,
      );
    }
    if (ids.has(mission.id)) {
      throw new CampaignValidationError('duplicate-id', `duplicate mission id "${mission.id}"`, mission.id);
    }
    ids.add(mission.id);
    if (orders.has(mission.order)) {
      throw new CampaignValidationError(
        'duplicate-order',
        `duplicate mission order ${mission.order} (at "${mission.id}")`,
        mission.id,
      );
    }
    orders.add(mission.order);

    const arena = buildArenaSafely(mission);
    arenas.set(mission.id, arena);
    validateObjective(mission);
    validateSpawns(mission, arena);
    validateEnemiesAndCover(mission, arena);
    validateProgression(mission);
  }

  // Orders must form a contiguous 1..N run — a gap means a mission is missing.
  const sortedOrders = [...orders].sort((a, b) => a - b);
  for (let i = 0; i < sortedOrders.length; i++) {
    if (sortedOrders[i] !== i + 1) {
      throw new CampaignValidationError(
        'non-contiguous-order',
        `mission orders must be a contiguous 1..${sortedOrders.length} run; got [${sortedOrders.join(', ')}]`,
      );
    }
  }

  const ordered = [...missions].sort((a, b) => a.order - b.order);
  const orderedIds = ordered.map((m) => m.id);
  const byIdMap = new Map(ordered.map((m) => [m.id as string, m]));
  const byOrderMap = new Map(ordered.map((m) => [m.order, m]));

  return {
    missions: Object.freeze(ordered),
    ids: Object.freeze(orderedIds),
    count: ordered.length,
    firstMissionId: orderedIds[0],
    byId: (id) => byIdMap.get(id),
    byOrder: (order) => byOrderMap.get(order),
    has: (id) => byIdMap.has(id),
    arenaFor: (id) => {
      const arena = arenas.get(id);
      if (!arena) throw new CampaignValidationError('invalid-arena', `no arena cached for "${id}"`, id);
      return arena;
    },
    nextMissionId: (id) => {
      const idx = orderedIds.indexOf(id);
      return idx >= 0 && idx + 1 < orderedIds.length ? orderedIds[idx + 1] : null;
    },
    previousMissionId: (id) => {
      const idx = orderedIds.indexOf(id);
      return idx > 0 ? orderedIds[idx - 1] : null;
    },
  };
}
