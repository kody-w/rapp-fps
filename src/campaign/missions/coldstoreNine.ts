/**
 * Mission 7 — "Coldstore Nine".
 *
 * A frozen cold-storage warehouse, power failing: pale-ice light, breath-fog,
 * tall pallet racks running north in long aisles. Three defenders holding a
 * freezer control room, with racks that make every lane a blind corridor. The
 * last of the escalation tier before the siege missions.
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

const BOUNDS = { xMin: -14, xMax: 14, zMin: -25, zMax: 1 } as const;

function buildColdstore(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => { for (const x of s) solids.push(x); };

  push(floorSlab(BOUNDS));
  push(...perimeter(BOUNDS, { northTop: 6.2, sideTop: 3.6, southTop: 3.2, tint: TINT.paleIce }));

  // Tall pallet racks — long blind aisles running north.
  push(
    onFloor('rack-w1', [-8, -8], [1.2, 6.0], 2.6, 'darkMetal', 'metal', { tint: TINT.paleIce }),
    onFloor('rack-e1', [8, -11], [1.2, 6.0], 2.6, 'darkMetal', 'metal', { tint: TINT.paleIce }),
  );

  // Ice-crusted crates + a compressor block.
  push(
    onFloor('crate-c1', [0, -7], [2.0, 2.0], 1.4, 'galvanized', 'metal', { tint: TINT.paleIce }),
    onFloor('crate-c2', [1, -15], [1.8, 1.8], 1.3, 'wood', 'wood'),
    onFloor('compressor', [-4, -18], [2.4, 2.0], 1.6, 'concreteDark', 'concrete'),
  );

  // Objective: the freezer control room at the north wall.
  push(
    onFloor('control-obj', [2, -23], [8, 1.4], 0.95, 'concrete', 'concrete'),
    onFloor('panel-n', [-3, -21], [1.0, 1.0], 1.2, 'galvanized', 'metal', { tint: TINT.paleIce }),
  );

  push(
    onFloor('crate-s1', [-5, -3], [1.6, 1.6], 1.4, 'wood', 'wood'),
    onFloor('crate-s2', [5, -3], [1.6, 1.6], 1.4, 'wood', 'wood'),
  );

  push(
    box('beacon', [2, 1.5, -22.9], [0.45, 1.2, 0.45], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('lamp-e', [BOUNDS.xMax - 0.35, 3.0, -12.0], [0.5, 0.3, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );

  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xcfe4f2, intensity: 1.9, position: [-8, 14, 6], castShadow: true },
    { kind: 'hemisphere', color: 0x63798c, groundColor: 0x171d22, intensity: 0.64 },
    { kind: 'point', color: 0xffb060, intensity: 18, position: [BOUNDS.xMax - 0.7, 2.95, -12.0], distance: 13, decay: 2 },
    { kind: 'point', color: 0x8fd0ea, intensity: 15, position: [2, 1.9, -22.9], distance: 11, decay: 2 },
  ];

  const shots: ShotSpec[] = [
    { name: 'spawn', position: [0, 1.7, -0.4], lookAt: [1, 1.4, -18], caption: 'Failing cold store from the pad: pallet racks make blind corridors north.' },
    { name: 'silhouette', position: [-13, 2.6, 0.4], lookAt: [8, 2.1, -19], caption: 'Wide pale-ice silhouette: racks, compressor and the cold control beacon.' },
  ];

  const playerSpawn = assertClearFloor([0, 0, -0.4], solids, 'coldstore player spawn');
  const enemyPrimary = assertClearFloor([2, 0, -21.1], solids, 'coldstore primary defender');
  const enemyCoverIds = assertCover(
    ['control-obj', 'panel-n', 'rack-w1', 'rack-e1', 'compressor'],
    solids,
    'coldstore cover',
  );

  return makeArena({
    solids, lights, shots,
    playerSpawn, enemySpawn: enemyPrimary, enemyCoverIds,
    fog: { color: 0x141b21, density: 0.03 },
  });
}

const arena = buildColdstore();

export const coldstoreNine: MissionDefinition = defineMission({
  id: 'coldstore-nine',
  order: 7,
  title: 'Coldstore Nine',
  brief:
    'A frozen cold-storage warehouse with the power failing. A defender holds the '
    + 'freezer control room at the end of long, blind rack aisles. Peek the corners '
    + 'and do not get caught mid-lane on the approach.',
  primarySpawnLabel: 'South dock pad',
  objective: {
    kind: 'secure',
    title: 'HOLD COLDSTORE CONTROL',
    summary: 'Eliminate the defender and secure the freezer control room.',
    target: [2, 0, -22.9],
  },
  createArena: buildColdstore,
  enemies: [
    { id: 'freezer-lead', spawn: arena.enemySpawn, yaw: faceToward(arena.enemySpawn, arena.playerSpawn), coverSolidIds: ['control-obj', 'panel-n', 'compressor'] },
  ],
  visual: {
    palette: 'pale-ice cold storage / pallet racks',
    timeOfDay: 'power-failing dark',
    loadingBlurb: 'COLDSTORE // UNIT 9',
    accentColor: 0x8fd0ea,
  },
});
