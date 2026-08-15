/**
 * Synthetic mission fixtures — test-only.
 *
 * The shipping surface is generic: it exports the reviewed Cargo Breach adapter
 * plus the catalog/progress/persistence machinery, and integration supplies the
 * reviewed Relay/Foundry definitions after their PRs merge. The deterministic
 * suite still has to exercise *multi-mission* logic (progression, finale,
 * persistence, deep links) today, so it composes a catalog from the real
 * `cargoBreach` (mission 1) plus these two obviously-synthetic fixtures.
 *
 * They are named `fixture-*` on purpose: nothing here pretends to be a shipping
 * mission. Each fixture builds a tiny, honest room via the test authoring
 * helpers (a floor slab, four walls, and one body-height crate per defender that
 * genuinely collides), so it passes the exact same catalog validation the real
 * missions do — floor-based clear spawns, collidable cover, in-range progression.
 */

import type { ArenaDefinition } from '../../level/arena.js';
import type { MissionDefinition, SpawnSlot } from '../types.js';
import type { MissionId } from '../ids.js';
import { asMissionId } from '../ids.js';
import { assembleArena, onFloor, roomShell } from './authoring.js';

interface FixtureOptions {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly objectiveTitle: string;
  readonly enemyCount: 1 | 2;
  readonly banksOnElimination: boolean;
  readonly retryFrom: 'mission-start' | 'last-checkpoint';
}

const SPAWN_A: SpawnSlot = { id: 'insertion-a', label: 'Primary insertion', position: [-4, 0, -2], yaw: 0 };
const SPAWN_B: SpawnSlot = { id: 'insertion-b', label: 'Secondary insertion', position: [4, 0, -2], yaw: 0 };

/** Two crates so a two-defender fixture has one collidable cover box each. */
const CRATES = [
  { id: 'crate-a', xz: [-3, -8] as const, enemy: [-3, 0, -6] as const },
  { id: 'crate-b', xz: [3, -8] as const, enemy: [3, 0, -6] as const },
];

function fixtureArena(enemyCount: number): ArenaDefinition {
  const shell = roomShell({ x: [-8, 8], z: [-12, 0], wallHeight: 3 });
  const crates = CRATES.slice(0, enemyCount).map((c) =>
    onFloor(c.id, c.xz, [1.2, 1.2], 1.4, 'container', 'metal'),
  );
  return assembleArena({
    solids: [...shell, ...crates],
    lights: [{ kind: 'hemisphere', color: 0x8899aa, intensity: 0.8, groundColor: 0x111111 }],
    shots: [],
    playerSpawn: SPAWN_A.position,
    enemySpawn: CRATES[0].enemy,
    enemyCoverIds: crates.map((c) => c.id),
    fog: { color: 0x0a0c10, density: 0.02 },
  });
}

/** Build a `MissionDefinition` that passes the same catalog validation as a real mission. */
export function fixtureMission(opts: FixtureOptions): MissionDefinition {
  const enemies = CRATES.slice(0, opts.enemyCount).map((c, i) => ({
    id: `defender-${i + 1}`,
    spawn: c.enemy,
    yaw: Math.PI,
    coverSolidIds: [c.id],
  }));
  return {
    id: asMissionId(opts.id),
    order: opts.order,
    title: opts.title,
    brief: `Synthetic fixture "${opts.id}" for deterministic multi-mission tests.`,
    objective: {
      kind: 'eliminate',
      title: opts.objectiveTitle,
      summary: `Clear the ${opts.enemyCount} defender(s) in the ${opts.title} fixture.`,
    },
    createArena: () => fixtureArena(opts.enemyCount),
    playerSpawns: [SPAWN_A, SPAWN_B],
    enemies,
    completion: { kind: 'eliminate-all-enemies' },
    failure: { kind: 'player-death', retryFrom: opts.retryFrom },
    checkpoint: { initial: 'mission-start', banksOnElimination: opts.banksOnElimination },
  };
}

/**
 * Mission 2 fixture: two defenders, banks each elimination and retries from the
 * last checkpoint (exercises the "death resumes from checkpoint" path).
 */
export const fixtureBravo: MissionDefinition = fixtureMission({
  id: 'fixture-bravo',
  order: 2,
  title: 'Fixture Bravo',
  objectiveTitle: 'HOLD THE RELAY',
  enemyCount: 2,
  banksOnElimination: true,
  retryFrom: 'last-checkpoint',
});

/**
 * Mission 3 fixture (finale): two defenders, no banking and a mission-start
 * retry (exercises the "death wipes progress" path and campaign completion).
 */
export const fixtureCharlie: MissionDefinition = fixtureMission({
  id: 'fixture-charlie',
  order: 3,
  title: 'Fixture Charlie',
  objectiveTitle: 'BREACH THE CORE',
  enemyCount: 2,
  banksOnElimination: false,
  retryFrom: 'mission-start',
});

export const fixtureBravoId: MissionId = fixtureBravo.id;
export const fixtureCharlieId: MissionId = fixtureCharlie.id;
