/**
 * Mission 6 — "Glasshouse".
 *
 * An overgrown research biodome gone feral: moss-green light, humid haze, raised
 * planter beds and a central water tank. Three defenders now — a seed-vault
 * holder at the north end and two rovers working the east trellis and the west
 * planters. The tank and beds cut the dome into looping lanes; there is no single
 * straight push.
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

const BOUNDS = { xMin: -14, xMax: 14, zMin: -24, zMax: 1 } as const;

function buildGlasshouse(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => { for (const x of s) solids.push(x); };

  push(floorSlab(BOUNDS));
  push(...perimeter(BOUNDS, { northTop: 5.6, sideTop: 3.4, southTop: 3.0, tint: TINT.mossGreen }));

  // Raised planter beds — waist-to-chest cover in a loose ring.
  push(
    onFloor('planter-w1', [-8, -6], [3.5, 1.4], 1.0, 'concrete', 'concrete', { tint: TINT.mossGreen }),
    onFloor('planter-w2', [-9, -16], [3.5, 1.4], 1.0, 'concreteDark', 'concrete', { tint: TINT.mossGreen }),
    onFloor('planter-e1', [8, -9], [1.4, 3.5], 1.0, 'concrete', 'concrete', { tint: TINT.mossGreen }),
  );

  // Central water tank + a fallen support beam + east trellis frame.
  push(
    onFloor('tank-c', [0, -12], [2.6, 2.6], 2.0, 'galvanized', 'metal', { tint: TINT.fadedTeal }),
    onFloor('beam-w', [-4, -10], [0.8, 4.0], 1.2, 'wood', 'wood'),
    onFloor('trellis-e', [7, -17], [2.4, 0.6], 2.2, 'darkMetal', 'metal', { tint: TINT.mossGreen }),
  );

  // Objective: the seed vault at the north apse.
  push(
    onFloor('vault-obj', [-2, -22], [8, 1.4], 0.95, 'concrete', 'concrete'),
    onFloor('seed-pod', [3, -20], [1.0, 1.0], 1.1, 'rust', 'metal', { tint: TINT.mossGreen }),
  );

  push(
    onFloor('planter-s1', [-5, -3], [2.4, 1.0], 0.9, 'concrete', 'concrete', { tint: TINT.mossGreen }),
    onFloor('planter-s2', [5, -3], [2.4, 1.0], 0.9, 'concreteDark', 'concrete', { tint: TINT.mossGreen }),
  );

  push(
    box('beacon', [-2, 1.5, -21.9], [0.45, 1.2, 0.45], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('lamp-hang', [0, 3.4, -8.0], [0.6, 0.28, 0.6], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );

  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xd7e8b8, intensity: 2.1, position: [-7, 14, 5], castShadow: true },
    { kind: 'hemisphere', color: 0x5a7a4a, groundColor: 0x1a2414, intensity: 0.7 },
    { kind: 'point', color: 0xbfe08a, intensity: 20, position: [0, 3.3, -8.0], distance: 14, decay: 2 },
    { kind: 'point', color: 0x7fe0a8, intensity: 14, position: [-2, 1.9, -21.9], distance: 10, decay: 2 },
  ];

  const shots: ShotSpec[] = [
    { name: 'spawn', position: [0, 1.7, -0.4], lookAt: [-1, 1.4, -16], caption: 'Feral biodome from the pad: the water tank and planter ring loop the lanes.' },
    { name: 'silhouette', position: [-13, 2.6, 0.4], lookAt: [7, 2.1, -18], caption: 'Wide moss-green silhouette: planters, tank and trellis under humid haze.' },
  ];

  const playerSpawn = assertClearFloor([0, 0, -0.4], solids, 'glasshouse player spawn');
  const enemyPrimary = assertClearFloor([-2, 0, -20.1], solids, 'glasshouse primary defender');
  const enemyCoverIds = assertCover(
    ['vault-obj', 'seed-pod', 'tank-c', 'planter-e1', 'planter-w1'],
    solids,
    'glasshouse cover',
  );

  return makeArena({
    solids, lights, shots,
    playerSpawn, enemySpawn: enemyPrimary, enemyCoverIds,
    fog: { color: 0x17241a, density: 0.03 },
  });
}

const arena = buildGlasshouse();

export const glasshouse: MissionDefinition = defineMission({
  id: 'glasshouse',
  order: 6,
  title: 'Glasshouse',
  brief:
    'An overgrown research biodome gone feral. A seed-vault holder waits at the '
    + 'north apse, screened by the central water tank and a ring of planter beds — '
    + 'there is no straight push. Loop the cover and take the vault.',
  primarySpawnLabel: 'South vestibule pad',
  objective: {
    kind: 'secure',
    title: 'RECOVER THE SEED VAULT',
    summary: 'Eliminate the defender and secure the north seed vault.',
    target: [-2, 0, -21.9],
  },
  createArena: buildGlasshouse,
  enemies: [
    { id: 'garden-warden', spawn: arena.enemySpawn, yaw: faceToward(arena.enemySpawn, arena.playerSpawn), coverSolidIds: ['vault-obj', 'seed-pod', 'planter-w2'] },
  ],
  visual: {
    palette: 'moss-green feral biodome / raised planters',
    timeOfDay: 'humid greenlight',
    loadingBlurb: 'ARBORETUM // GLASSHOUSE 6',
    accentColor: 0x7fe0a8,
  },
});
