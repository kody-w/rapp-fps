/**
 * Mission 5 — "Emberline Yards".
 *
 * A desert freight yard burning down into dusk: ochre dust, rust rolling stock,
 * warm sodium floods. Two defenders — a signal-tower holder at the north control
 * and a flanker working the east rolling stock. Long sightlines down the rail
 * aisles reward using the cars for cover on the push.
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

const BOUNDS = { xMin: -14, xMax: 14, zMin: -23, zMax: 1 } as const;

function buildEmberlineYards(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => { for (const x of s) solids.push(x); };

  push(floorSlab(BOUNDS));
  push(...perimeter(BOUNDS, { northTop: 6.0, sideTop: 3.2, southTop: 2.8, material: 'concrete', tint: TINT.ochre }));

  // Rolling stock — long hard cover along both aisles.
  push(
    onFloor('railcar-w', [-6, -8], [8, 2.4], 2.6, 'darkMetal', 'metal', { tint: TINT.slateGrey }),
    onFloor('railcar-e', [7, -13], [2.4, 8], 2.6, 'rust', 'metal', { tint: TINT.oxideRust }),
  );

  // Berms, sleepers, water-tower base.
  push(
    onFloor('berm-w', [-10, -14], [3, 3], 1.4, 'concrete', 'concrete', { tint: TINT.ochre }),
    onFloor('sleepers', [2, -6], [2.0, 1.2], 1.1, 'wood', 'wood'),
    onFloor('tower-base', [9, -5], [2.2, 2.2], 1.6, 'concreteDark', 'concrete'),
  );

  // Objective: the signal control at the north headshunt.
  push(
    onFloor('signal-obj', [-2, -21], [8, 1.4], 0.95, 'concrete', 'concrete'),
    onFloor('signal-post', [3, -19], [0.9, 0.9], 1.3, 'galvanized', 'metal', { tint: TINT.sodiumAmber }),
  );

  push(
    onFloor('crate-s1', [-5, -3], [1.6, 1.6], 1.4, 'wood', 'wood'),
    onFloor('crate-s2', [5, -3], [1.6, 1.6], 1.4, 'wood', 'wood'),
  );

  push(
    box('beacon', [-2, 1.55, -20.9], [0.45, 1.2, 0.45], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('lamp-w', [BOUNDS.xMin + 0.35, 3.0, -10.0], [0.5, 0.3, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );

  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xffcf8f, intensity: 2.6, position: [-8, 13, 6], castShadow: true },
    { kind: 'hemisphere', color: 0xb07a4a, groundColor: 0x2a1c10, intensity: 0.6 },
    { kind: 'point', color: 0xff9a44, intensity: 26, position: [BOUNDS.xMin + 0.7, 2.95, -10.0], distance: 15, decay: 2 },
    { kind: 'point', color: 0xffbf70, intensity: 18, position: [-2, 1.9, -20.9], distance: 10, decay: 2 },
  ];

  const shots: ShotSpec[] = [
    { name: 'spawn', position: [0, 1.7, -0.4], lookAt: [-1, 1.4, -17], caption: 'Dusk yard from the pad: rolling stock breaks the aisles toward the signal control.' },
    { name: 'silhouette', position: [-13, 2.6, 0.4], lookAt: [8, 2.1, -17], caption: 'Wide ochre silhouette: rail cars, berm and the warm-lit signal tower.' },
  ];

  const playerSpawn = assertClearFloor([0, 0, -0.4], solids, 'emberline player spawn');
  const enemyPrimary = assertClearFloor([-2, 0, -19.1], solids, 'emberline primary defender');
  const enemyCoverIds = assertCover(
    ['signal-obj', 'signal-post', 'railcar-w', 'railcar-e', 'tower-base'],
    solids,
    'emberline cover',
  );

  return makeArena({
    solids, lights, shots,
    playerSpawn, enemySpawn: enemyPrimary, enemyCoverIds,
    fog: { color: 0x2c1d10, density: 0.028 },
  });
}

const arena = buildEmberlineYards();

export const emberlineYards: MissionDefinition = defineMission({
  id: 'emberline-yards',
  order: 5,
  title: 'Emberline Yards',
  brief:
    'A desert freight yard at burning dusk. A signal-tower holder guards the north '
    + 'control across long open aisles broken only by rolling stock. Use the cars '
    + 'for cover on the approach and seize the signal.',
  primarySpawnLabel: 'South headshunt pad',
  objective: {
    kind: 'secure',
    title: 'TAKE THE EMBERLINE SIGNAL',
    summary: 'Eliminate the defender and seize the north signal control.',
    target: [-2, 0, -20.9],
  },
  createArena: buildEmberlineYards,
  enemies: [
    { id: 'yard-boss', spawn: arena.enemySpawn, yaw: faceToward(arena.enemySpawn, arena.playerSpawn), coverSolidIds: ['signal-obj', 'signal-post', 'railcar-w'] },
  ],
  visual: {
    palette: 'ochre desert rail yard / rust rolling stock',
    timeOfDay: 'burning dusk',
    loadingBlurb: 'EMBERLINE // YARD 5',
    accentColor: 0xffb060,
  },
});
