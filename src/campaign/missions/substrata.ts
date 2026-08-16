/**
 * Mission 8 — "Substrata".
 *
 * A dead metro interchange far underground: sodium-orange gloom, a stalled train
 * on the east track, structural pillars marching the concourse, a raised west
 * platform edge. The siege tier opens here with FOUR defenders spread across
 * platform, pillars and a control booth — the first mission where holding an
 * angle is not enough and you must clear in stages.
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

const BOUNDS = { xMin: -15, xMax: 15, zMin: -27, zMax: 1 } as const;

function buildSubstrata(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => { for (const x of s) solids.push(x); };

  push(floorSlab(BOUNDS));
  push(...perimeter(BOUNDS, { northTop: 6.6, sideTop: 3.8, southTop: 3.2, tint: TINT.slateGrey }));

  // Structural pillars marching the concourse.
  push(
    onFloor('pillar-1', [-6, -7], [1.0, 1.0], 3.0, 'concrete', 'concrete'),
    onFloor('pillar-2', [6, -7], [1.0, 1.0], 3.0, 'concrete', 'concrete'),
    onFloor('pillar-3', [-6, -17], [1.0, 1.0], 3.0, 'concreteDark', 'concrete'),
    onFloor('pillar-4', [6, -17], [1.0, 1.0], 3.0, 'concreteDark', 'concrete'),
  );

  // West platform edge (raised low) + stalled east train + a central kiosk/barrier.
  push(
    onFloor('platform-w', [-11, -13], [1.6, 10], 1.0, 'concrete', 'concrete', { tint: TINT.slateGrey }),
    onFloor('traincar', [10, -14], [2.6, 9], 2.8, 'darkMetal', 'metal', { tint: TINT.slateGrey }),
    onFloor('barrier-c', [0, -9], [3.0, 0.7], 1.1, 'galvanized', 'metal', { tint: TINT.sodiumAmber }),
    onFloor('kiosk', [-2, -15], [2.0, 2.0], 1.6, 'concreteDark', 'concrete'),
  );

  // Objective: the control booth at the north headwall.
  push(
    onFloor('booth-obj', [2, -25], [8, 1.4], 0.95, 'concrete', 'concrete'),
    onFloor('console-n', [-3, -23], [1.0, 1.0], 1.2, 'galvanized', 'metal', { tint: TINT.sodiumAmber }),
  );

  push(
    onFloor('turnstile-1', [-5, -3], [2.2, 0.7], 1.1, 'galvanized', 'metal', { tint: TINT.sodiumAmber }),
    onFloor('turnstile-2', [5, -3], [2.2, 0.7], 1.1, 'galvanized', 'metal', { tint: TINT.sodiumAmber }),
  );

  push(
    box('beacon', [2, 1.5, -24.9], [0.45, 1.2, 0.45], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('lamp-w', [BOUNDS.xMin + 0.35, 3.0, -10.0], [0.5, 0.3, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
    box('lamp-e', [BOUNDS.xMax - 0.35, 3.0, -19.0], [0.5, 0.3, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );

  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xf0d2a0, intensity: 1.6, position: [-6, 13, 5], castShadow: true },
    { kind: 'hemisphere', color: 0x6a5030, groundColor: 0x14100a, intensity: 0.5 },
    { kind: 'point', color: 0xff9a44, intensity: 24, position: [BOUNDS.xMin + 0.7, 2.95, -10.0], distance: 15, decay: 2 },
    { kind: 'point', color: 0xff9a44, intensity: 22, position: [BOUNDS.xMax - 0.7, 2.95, -19.0], distance: 14, decay: 2 },
    { kind: 'point', color: 0xffbf70, intensity: 16, position: [2, 1.9, -24.9], distance: 10, decay: 2 },
  ];

  const shots: ShotSpec[] = [
    { name: 'spawn', position: [0, 1.7, -0.4], lookAt: [1, 1.4, -20], caption: 'Dead metro from the turnstiles: pillars and the stalled train stage the concourse.' },
    { name: 'silhouette', position: [-14, 2.6, 0.4], lookAt: [9, 2.1, -20], caption: 'Wide sodium silhouette: pillars, platform edge, train and the control booth.' },
  ];

  const playerSpawn = assertClearFloor([0, 0, -0.4], solids, 'substrata player spawn');
  const enemyPrimary = assertClearFloor([2, 0, -23.1], solids, 'substrata primary defender');
  const enemyCoverIds = assertCover(
    ['booth-obj', 'console-n', 'platform-w', 'traincar', 'kiosk'],
    solids,
    'substrata cover',
  );

  return makeArena({
    solids, lights, shots,
    playerSpawn, enemySpawn: enemyPrimary, enemyCoverIds,
    fog: { color: 0x120e08, density: 0.032 },
  });
}

const arena = buildSubstrata();

export const substrata: MissionDefinition = defineMission({
  id: 'substrata',
  order: 8,
  title: 'Substrata',
  brief:
    'A dead metro interchange far underground. A defender holds the north control '
    + 'booth deep past a pillar concourse and a stalled train, with long crossing '
    + 'sightlines. Advance pillar to pillar; the open platform is a kill lane.',
  primarySpawnLabel: 'Turnstile concourse',
  objective: {
    kind: 'secure',
    title: 'CLEAR THE INTERCHANGE',
    summary: 'Eliminate the defender and secure the north control booth.',
    target: [2, 0, -24.9],
  },
  createArena: buildSubstrata,
  enemies: [
    { id: 'platform-chief', spawn: arena.enemySpawn, yaw: faceToward(arena.enemySpawn, arena.playerSpawn), coverSolidIds: ['booth-obj', 'console-n', 'kiosk'] },
  ],
  visual: {
    palette: 'sodium-orange dead metro / stalled train',
    timeOfDay: 'deep underground',
    loadingBlurb: 'SUBSTRATA // LINE 8',
    accentColor: 0xffb060,
  },
});
