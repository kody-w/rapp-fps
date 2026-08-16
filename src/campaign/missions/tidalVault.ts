/**
 * Mission 4 — "Tidal Vault".
 *
 * A flooded coastal sluice vault at slack tide: teal murk, dripping concrete,
 * galvanised gate leaves. The first real escalation — TWO defenders. One holds
 * the sluice-control ledge at the north end; a second roves the east pump aisle,
 * so the straight push up the middle is flanked. Break line with the central
 * gate leaves, then choose a lane.
 *
 * Authored with the shared campaign helpers (`authoring.ts`): pure box-world
 * data the catalog re-validates against the geometry `createArena` produces.
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

const BOUNDS = { xMin: -13, xMax: 13, zMin: -22, zMax: 1 } as const;

function buildTidalVault(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => { for (const x of s) solids.push(x); };

  push(floorSlab(BOUNDS));
  push(...perimeter(BOUNDS, { northTop: 6.4, sideTop: 3.4, southTop: 3.0, tint: TINT.paleIce }));

  // Central sluice gate leaves — the chokepoint that breaks the spawn→objective line.
  push(
    onFloor('sluice-w', [-3, -11], [3.0, 0.8], 2.3, 'galvanized', 'metal', { tint: TINT.fadedTeal }),
    onFloor('sluice-e', [4, -9], [3.0, 0.8], 2.2, 'darkMetal', 'metal', { tint: TINT.slateGrey }),
  );

  // Pump housings — chest-to-shoulder hard cover flanking the aisles.
  push(
    onFloor('pump-w1', [-8, -6], [2.2, 2.2], 1.35, 'concrete', 'concrete'),
    onFloor('pump-w2', [-9, -15], [1.8, 1.8], 1.25, 'rust', 'metal', { tint: TINT.oxideRust }),
    onFloor('pump-e1', [8, -13], [2.2, 2.2], 1.35, 'concreteDark', 'concrete'),
    onFloor('drum-c', [1, -14], [0.8, 0.8], 1.0, 'rust', 'metal', { tint: TINT.oxideRust }),
  );

  // Objective: the north sluice-control ledge and its valve stack.
  push(
    onFloor('sluice-obj', [-2, -20], [8, 1.4], 0.95, 'concrete', 'concrete'),
    onFloor('valve-n', [2, -18.5], [1.0, 1.0], 1.1, 'galvanized', 'metal', { tint: TINT.fadedTeal }),
  );

  // Opening cover near the deploy pads.
  push(
    onFloor('jersey-s1', [-6, -3], [2.4, 0.7], 1.1, 'concrete', 'concrete'),
    onFloor('jersey-s2', [6, -3], [2.4, 0.7], 1.1, 'concreteDark', 'concrete'),
  );

  // Render-only dressing: cold control beacon + a warm inspection lamp.
  push(
    box('beacon', [-2, 1.5, -19.9], [0.45, 1.2, 0.45], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('lamp-e', [BOUNDS.xMax - 0.35, 3.0, -8.0], [0.5, 0.3, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );

  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xbfe0ea, intensity: 2.0, position: [-8, 14, 6], castShadow: true },
    { kind: 'hemisphere', color: 0x486d7d, groundColor: 0x14201f, intensity: 0.66 },
    { kind: 'point', color: 0xffab55, intensity: 22, position: [BOUNDS.xMax - 0.7, 2.95, -8.0], distance: 14, decay: 2 },
    { kind: 'point', color: 0x49c9d6, intensity: 16, position: [-2, 1.9, -19.9], distance: 11, decay: 2 },
  ];

  const shots: ShotSpec[] = [
    { name: 'spawn', position: [0, 1.7, -0.4], lookAt: [-1, 1.4, -16], caption: 'Slack-tide vault from the deploy pad: the twin gate leaves break the straight line north.' },
    { name: 'silhouette', position: [-12, 2.6, 0.4], lookAt: [7, 2.1, -17], caption: 'Wide teal silhouette: gate leaves, pump housings and the cold sluice beacon.' },
  ];

  const playerSpawn = assertClearFloor([0, 0, -0.4], solids, 'tidal-vault player spawn');
  const enemyPrimary = assertClearFloor([-2, 0, -18.1], solids, 'tidal-vault primary defender');
  const enemyCoverIds = assertCover(
    ['sluice-obj', 'valve-n', 'sluice-w', 'sluice-e', 'pump-e1'],
    solids,
    'tidal-vault cover',
  );

  return makeArena({
    solids,
    lights,
    shots,
    playerSpawn,
    enemySpawn: enemyPrimary,
    enemyCoverIds,
    fog: { color: 0x16303a, density: 0.03 },
  });
}

const arena = buildTidalVault();

export const tidalVault: MissionDefinition = defineMission({
  id: 'tidal-vault',
  order: 4,
  title: 'Tidal Vault',
  brief:
    'A flooded coastal sluice vault at slack tide. One defender holds the north '
    + 'control ledge behind the sluice gates, watching the only clean line up the '
    + 'middle. Break the gate line and take the vault before the tide turns.',
  primarySpawnLabel: 'South pump-gallery pad',
  objective: {
    kind: 'secure',
    title: 'SEAL THE SLUICE VAULT',
    summary: 'Eliminate the defender and secure the north sluice control.',
    target: [-2, 0, -19.9],
  },
  createArena: buildTidalVault,
  enemies: [
    { id: 'vault-warden', spawn: arena.enemySpawn, yaw: faceToward(arena.enemySpawn, arena.playerSpawn), coverSolidIds: ['sluice-obj', 'valve-n', 'sluice-w'] },
  ],
  visual: {
    palette: 'teal flood vault / galvanised gates',
    timeOfDay: 'slack tide, overcast',
    loadingBlurb: 'TIDEWORKS // VAULT 4',
    accentColor: 0x49c9d6,
  },
});
