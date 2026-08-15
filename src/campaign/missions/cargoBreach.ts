/**
 * Mission 1 — "Cargo Breach".
 *
 * This is the shipping arena (`buildArena()`), adapted into the mission contract
 * *without editing a single level file*. The first spawn is the arena's own
 * `playerSpawn`; the second is **derived and validated** by
 * `deriveClearFloorSpawn` against the real collidable solids, so the two-man
 * insertion is a proven-clear point, not a coordinate invented inside a
 * container. The defender and its cover come straight from the arena's authored
 * `enemySpawn` / `enemyCoverIds`, so campaign and level cannot disagree about
 * where the enemy holds or what it hides behind.
 */

import { buildArena } from '../../level/arena.js';
import { deriveClearFloorSpawn } from '../spawns.js';
import { asMissionId } from '../ids.js';
import type { MissionDefinition, SpawnSlot, Vec3 } from '../types.js';

const arena = buildArena();

const primarySpawn: Vec3 = arena.playerSpawn;
const derived = deriveClearFloorSpawn(arena, primarySpawn, {
  avoid: [primarySpawn],
  minSeparation: 2.5,
});

const spawnA: SpawnSlot = {
  id: 'insertion-primary',
  label: 'Primary insertion',
  position: primarySpawn,
  yaw: 0,
};
const spawnB: SpawnSlot = {
  id: 'insertion-secondary',
  label: 'Secondary insertion (derived, clearance-proven)',
  position: derived.position,
  yaw: 0,
};

export const cargoBreach: MissionDefinition = {
  id: asMissionId('cargo-breach'),
  order: 1,
  title: 'Cargo Breach',
  brief:
    'Blue-hour cargo bay. One defender holds the beacon terminal at the loading '
    + 'dock. Break the straight sightline through the container stack and take the '
    + 'objective end.',
  objective: {
    kind: 'eliminate',
    summary: 'Eliminate the defender holding the beacon terminal.',
    target: [0, 0, -19.1],
  },
  createArena: buildArena,
  playerSpawns: [spawnA, spawnB],
  enemies: [
    {
      id: 'defender',
      spawn: arena.enemySpawn,
      yaw: 0,
      coverSolidIds: arena.enemyCoverIds,
    },
  ],
  completion: { kind: 'eliminate-all-enemies' },
  failure: { kind: 'player-death', retryFrom: 'mission-start' },
  checkpoint: { initial: 'mission-start', banksOnElimination: false },
  visual: {
    palette: 'weathered ISO-container blue/oxide',
    timeOfDay: 'blue hour',
    loadingBlurb: 'DUSKLINE // CARGO BAY 7',
    accentColor: 0x4fd6ea,
  },
};

/** The clearance derivation record for the second spawn, exposed for evidence. */
export const cargoBreachDerivedSpawn = derived;
