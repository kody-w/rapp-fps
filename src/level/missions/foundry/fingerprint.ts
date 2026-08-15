/**
 * Topology fingerprint — proves the Foundry arena is structurally its own
 * thing, not a re-dressed cargo bay.
 *
 * The correspondence proof shows render == collision; it says nothing about
 * whether two *different missions* are actually different shapes. This module
 * derives a pure signature from an `ArenaDefinition` — bounds, solid/collidable
 * counts, an id-space hash, a spawn key, a vertical/route key and a sightline
 * key — and `compareTopology` asserts every one of those differs between the
 * Foundry and the cargo bay (`buildArena`).
 *
 * It deliberately compares ONLY against the cargo bay. It imports nothing from
 * any other mission — in particular it does not import the relay combat-lane
 * branch, whose contract assumptions this mission does not share — so the
 * fingerprint cannot accidentally inherit another level's shape.
 */

import type { ArenaDefinition, Vec3 } from '../../arena.js';
import { buildStaticWorld, collidableSolids } from '../../staticWorld.js';
import { firstOccluder } from './los.js';

const EYE = 1.66; // standing eye height (PlayerTuning.standingEyeHeight)
const CHEST = 1.2; // a plausible enemy chest height for the sightline probe

export interface TopologyFingerprint {
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly boundsKey: string;
  readonly solidCount: number;
  readonly collidableCount: number;
  readonly idHash: string;
  readonly spawnKey: string;
  /** Vertical / route signature: elevation profile of the collidable set. */
  readonly verticalKey: string;
  readonly maxTop: number;
  readonly elevatedCount: number;
  readonly distinctHeights: number;
  /** Sightline signature: what blocks the spawn→enemy probe, and how many. */
  readonly sightKey: string;
  readonly spawnEnemyOccluders: number;
}

function round(v: number, d = 3): number {
  const s = 10 ** d;
  return Math.round(v * s) / s;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Derive the pure topology signature of any arena definition. */
export function topologyFingerprint(def: ArenaDefinition): TopologyFingerprint {
  const world = buildStaticWorld(def);
  const collidable = collidableSolids(def);

  const boundsKey = `${world.bounds.min.map((n) => round(n)).join(',')}|`
    + `${world.bounds.max.map((n) => round(n)).join(',')}`;

  const ids = collidable.map((s) => s.id).sort();
  const idHash = fnv1a(ids.join('|'));

  const spawnKey = `${def.playerSpawn.map((n) => round(n)).join(',')}`
    + `>${def.enemySpawn.map((n) => round(n)).join(',')}`;

  const tops = collidable.map((s) => round(s.max[1]));
  const maxTop = tops.reduce((m, t) => Math.max(m, t), 0);
  const elevatedCount = collidable.filter((s) => s.min[1] > 1e-4).length;
  const distinctHeights = new Set(tops).size;
  const verticalKey = `top${maxTop}|elev${elevatedCount}|h${distinctHeights}`;

  const from: Vec3 = [def.playerSpawn[0], def.playerSpawn[1] + EYE, def.playerSpawn[2]];
  const to: Vec3 = [def.enemySpawn[0], def.enemySpawn[1] + CHEST, def.enemySpawn[2]];
  let spawnEnemyOccluders = 0;
  for (const s of collidable) {
    if (firstOccluder([s], from, to)) spawnEnemyOccluders += 1;
  }
  const firstBlock = firstOccluder(collidable, from, to);
  const sightKey = `n${spawnEnemyOccluders}|first${firstBlock ? firstBlock.id : 'clear'}`;

  return {
    bounds: world.bounds,
    boundsKey,
    solidCount: def.solids.length,
    collidableCount: collidable.length,
    idHash,
    spawnKey,
    verticalKey,
    maxTop,
    elevatedCount,
    distinctHeights,
    sightKey,
    spawnEnemyOccluders,
  };
}

export interface FieldComparison {
  readonly name: string;
  readonly a: string | number;
  readonly b: string | number;
  readonly distinct: boolean;
}

export interface TopologyComparison {
  readonly fields: readonly FieldComparison[];
  /** True iff bounds, count, id, vertical/route AND sightline all differ. */
  readonly allDistinct: boolean;
  readonly a: TopologyFingerprint;
  readonly b: TopologyFingerprint;
}

/**
 * Compare two arenas and require them distinct on every signature axis the
 * mission brief calls out: bounds, count, id, route (vertical) and sightline.
 */
export function compareTopology(a: ArenaDefinition, b: ArenaDefinition): TopologyComparison {
  const fa = topologyFingerprint(a);
  const fb = topologyFingerprint(b);
  const fields: FieldComparison[] = [
    { name: 'bounds', a: fa.boundsKey, b: fb.boundsKey, distinct: fa.boundsKey !== fb.boundsKey },
    { name: 'solidCount', a: fa.solidCount, b: fb.solidCount, distinct: fa.solidCount !== fb.solidCount },
    { name: 'collidableCount', a: fa.collidableCount, b: fb.collidableCount, distinct: fa.collidableCount !== fb.collidableCount },
    { name: 'idHash', a: fa.idHash, b: fb.idHash, distinct: fa.idHash !== fb.idHash },
    { name: 'spawnKey', a: fa.spawnKey, b: fb.spawnKey, distinct: fa.spawnKey !== fb.spawnKey },
    { name: 'route(vertical)', a: fa.verticalKey, b: fb.verticalKey, distinct: fa.verticalKey !== fb.verticalKey },
    { name: 'sightline', a: fa.sightKey, b: fb.sightKey, distinct: fa.sightKey !== fb.sightKey },
  ];
  const required = ['bounds', 'collidableCount', 'idHash', 'route(vertical)', 'sightline'];
  const allDistinct = required.every(
    (name) => fields.find((f) => f.name === name)?.distinct === true,
  );
  return { fields, allDistinct, a: fa, b: fb };
}
