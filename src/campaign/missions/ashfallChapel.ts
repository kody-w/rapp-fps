/**
 * Mission 9 — "Ashfall Chapel".
 *
 * A cathedral raised over a dead foundry, now snowing ash: ember-red glow through
 * bone-pale broken columns, toppled pews, a collapsed altar. Four defenders hold
 * a reliquary at the north apse with layered nave cover. The penultimate siege:
 * long columns give the defenders crossing angles you must peel one at a time.
 */

import {
  TINT,
  assertClearFloor,
  assertCover,
  box,
  defineMission,
  faceToward,
  floorSlab,
  makeArena,
  onFloor,
  perimeter,
  type ArenaDefinition,
  type LightSpec,
  type ShotSpec,
  type Solid,
} from './authoring.js';
import type { MissionDefinition } from '../types.js';

const BOUNDS = { xMin: -15, xMax: 15, zMin: -28, zMax: 1 } as const;

function buildAshfallChapel(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => { for (const x of s) solids.push(x); };

  push(floorSlab(BOUNDS));
  push(...perimeter(BOUNDS, { northTop: 7.2, sideTop: 4.0, southTop: 3.2, tint: TINT.bone }));

  // Broken nave columns — tall cover with crossing sightlines.
  push(
    onFloor('col-w1', [-7, -8], [1.2, 1.2], 3.4, 'concrete', 'concrete', { tint: TINT.bone }),
    onFloor('col-e1', [7, -8], [1.2, 1.2], 3.4, 'concrete', 'concrete', { tint: TINT.bone }),
    onFloor('col-w2', [-7, -18], [1.2, 1.2], 2.6, 'concreteDark', 'concrete', { tint: TINT.bone }),
    onFloor('col-e2', [7, -18], [1.2, 1.2], 3.0, 'concrete', 'concrete', { tint: TINT.bone }),
  );

  // Collapsed altar rubble, toppled pews, a west brazier.
  push(
    onFloor('rubble-c', [0, -11], [3.0, 2.4], 1.3, 'concreteDark', 'concrete', { tint: TINT.emberRed }),
    onFloor('pews-w', [-3, -6], [1.0, 3.0], 0.9, 'wood', 'wood'),
    onFloor('pews-e', [3, -15], [1.0, 3.0], 0.9, 'wood', 'wood'),
    onFloor('brazier', [-10, -13], [1.4, 1.4], 1.4, 'rust', 'metal', { tint: TINT.emberRed }),
  );

  // Objective: the reliquary at the north apse (raised altar ledge).
  push(
    onFloor('altar-obj', [1, -26], [8, 1.6], 1.1, 'concrete', 'concrete', { tint: TINT.bone }),
    onFloor('reliquary', [-3, -24], [1.0, 1.0], 1.3, 'galvanized', 'metal', { tint: TINT.emberRed }),
  );

  push(
    onFloor('pew-s1', [-5, -3], [2.4, 1.0], 0.9, 'wood', 'wood'),
    onFloor('pew-s2', [5, -3], [2.4, 1.0], 0.9, 'wood', 'wood'),
  );

  push(
    box('beacon', [-3, 1.6, -24], [0.5, 1.3, 0.5], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('lamp-w', [BOUNDS.xMin + 0.35, 3.4, -13.0], [0.5, 0.3, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );

  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xffb488, intensity: 2.2, position: [-7, 15, 6], castShadow: true },
    { kind: 'hemisphere', color: 0x7a4a3a, groundColor: 0x1c120c, intensity: 0.55 },
    { kind: 'point', color: 0xff6a3a, intensity: 24, position: [-10, 2.6, -13.0], distance: 13, decay: 2 },
    { kind: 'point', color: 0xff7a4a, intensity: 18, position: [-3, 2.0, -24], distance: 11, decay: 2 },
  ];

  const shots: ShotSpec[] = [
    { name: 'spawn', position: [0, 1.7, -0.4], lookAt: [0, 1.4, -20], caption: 'Ashfall nave from the narthex: broken columns cross the aisle toward the reliquary.' },
    { name: 'silhouette', position: [-14, 2.8, 0.4], lookAt: [8, 2.2, -20], caption: 'Wide ember silhouette: bone columns, collapsed altar and the glowing reliquary.' },
  ];

  const playerSpawn = assertClearFloor([0, 0, -0.4], solids, 'ashfall player spawn');
  const enemyPrimary = assertClearFloor([1, 0, -24.1], solids, 'ashfall primary defender');
  const enemyCoverIds = assertCover(
    ['altar-obj', 'reliquary', 'col-w1', 'col-e1', 'rubble-c'],
    solids,
    'ashfall cover',
  );

  return makeArena({
    solids, lights, shots,
    playerSpawn, enemySpawn: enemyPrimary, enemyCoverIds,
    fog: { color: 0x1a100c, density: 0.03 },
  });
}

const arena = buildAshfallChapel();

export const ashfallChapel: MissionDefinition = defineMission({
  id: 'ashfall-chapel',
  order: 9,
  title: 'Ashfall Chapel',
  brief:
    'A cathedral raised over a dead foundry, snowing ash. A defender holds the '
    + 'north reliquary down a long broken nave of crossing column angles. Peel the '
    + 'columns one at a time; the open aisle is a kill lane.',
  primarySpawnLabel: 'South narthex',
  objective: {
    kind: 'secure',
    title: 'SEIZE THE RELIQUARY',
    summary: 'Eliminate the defender and secure the north reliquary.',
    target: [-3, 0, -24],
  },
  createArena: buildAshfallChapel,
  enemies: [
    { id: 'chapel-warden', spawn: arena.enemySpawn, yaw: faceToward(arena.enemySpawn, arena.playerSpawn), coverSolidIds: ['altar-obj', 'reliquary', 'col-e2'] },
  ],
  visual: {
    palette: 'ember-red ashfall cathedral / bone columns',
    timeOfDay: 'ashfall dusk',
    loadingBlurb: 'ASHFALL // CHAPEL 9',
    accentColor: 0xff7a4a,
  },
});
