/**
 * Mission 10 — "Vantage Spire" (the finale).
 *
 * A comms spire rooftop over a night city: cyan beacon-glow, wind, HVAC blocks
 * and antenna masts, a maintenance shed centring the deck. FIVE defenders ring a
 * transmitter core at the north edge — the hardest hold in the campaign, with a
 * symmetric outer pair, an inner pair and a command holder at the core. Nowhere
 * on the deck is safe from at least two guns; take it apart from the flanks in.
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

const BOUNDS = { xMin: -16, xMax: 16, zMin: -30, zMax: 1 } as const;

function buildVantageSpire(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => { for (const x of s) solids.push(x); };

  push(floorSlab(BOUNDS));
  push(...perimeter(BOUNDS, { northTop: 7.0, sideTop: 2.2, southTop: 2.2, tint: TINT.nightCyan }));

  // HVAC blocks — the outer and inner cover rings.
  push(
    onFloor('hvac-w1', [-9, -7], [2.6, 2.2], 1.5, 'galvanized', 'metal', { tint: TINT.nightCyan }),
    onFloor('hvac-e1', [9, -7], [2.6, 2.2], 1.5, 'galvanized', 'metal', { tint: TINT.nightCyan }),
    onFloor('hvac-w2', [-10, -17], [2.2, 2.2], 1.4, 'darkMetal', 'metal', { tint: TINT.slateGrey }),
    onFloor('hvac-e2', [10, -17], [2.2, 2.2], 1.4, 'darkMetal', 'metal', { tint: TINT.slateGrey }),
  );

  // Central maintenance shed + antenna masts + a duct run.
  push(
    onFloor('shed-c', [0, -10], [3.4, 3.0], 2.4, 'concreteDark', 'concrete'),
    onFloor('antenna-w', [-5, -20], [1.0, 1.0], 3.4, 'darkMetal', 'metal', { tint: TINT.nightCyan }),
    onFloor('antenna-e', [5, -20], [1.0, 1.0], 3.4, 'darkMetal', 'metal', { tint: TINT.nightCyan }),
    onFloor('duct-c', [1, -15], [4.0, 0.7], 1.1, 'galvanized', 'metal', { tint: TINT.nightCyan }),
  );

  // Objective: the transmitter core at the north edge.
  push(
    onFloor('core-obj', [1, -28], [9, 1.6], 1.1, 'concrete', 'concrete', { tint: TINT.nightCyan }),
    onFloor('transmitter', [-3, -26], [1.2, 1.2], 1.6, 'galvanized', 'metal', { tint: TINT.nightCyan }),
  );

  push(
    onFloor('parapet-s1', [-6, -3], [2.6, 0.7], 1.1, 'concrete', 'concrete'),
    onFloor('parapet-s2', [6, -3], [2.6, 0.7], 1.1, 'concreteDark', 'concrete'),
  );

  push(
    box('beacon', [-3, 1.65, -26], [0.5, 1.35, 0.5], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('beacon-cap', [-3, 2.45, -26], [0.64, 0.12, 0.64], 'darkMetal', 'metal', { collide: false, castShadow: false }),
    box('lamp-c', [0, 2.9, -10.0], [0.6, 0.28, 0.6], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );

  const lights: LightSpec[] = [
    { kind: 'directional', color: 0x9fc4d6, intensity: 1.7, position: [-8, 16, 6], castShadow: true },
    { kind: 'hemisphere', color: 0x35566a, groundColor: 0x0e161c, intensity: 0.5 },
    { kind: 'point', color: 0xffb060, intensity: 20, position: [0, 2.85, -10.0], distance: 14, decay: 2 },
    { kind: 'point', color: 0x4fd6ea, intensity: 22, position: [-3, 2.2, -26], distance: 12, decay: 2 },
  ];

  const shots: ShotSpec[] = [
    { name: 'spawn', position: [0, 1.7, -0.4], lookAt: [0, 1.4, -22], caption: 'Spire deck from the parapet: HVAC rings and antenna masts guard the transmitter core.' },
    { name: 'silhouette', position: [-15, 2.8, 0.4], lookAt: [9, 2.2, -22], caption: 'Wide night-cyan silhouette: the whole rooftop ring against the city and the cold core beacon.' },
  ];

  const playerSpawn = assertClearFloor([0, 0, -0.4], solids, 'vantage player spawn');
  const enemyPrimary = assertClearFloor([1, 0, -26.2], solids, 'vantage command defender');
  const enemyCoverIds = assertCover(
    ['core-obj', 'transmitter', 'shed-c', 'hvac-w1', 'hvac-e1'],
    solids,
    'vantage cover',
  );

  return makeArena({
    solids, lights, shots,
    playerSpawn, enemySpawn: enemyPrimary, enemyCoverIds,
    fog: { color: 0x0d151b, density: 0.028 },
  });
}

const arena = buildVantageSpire();

export const vantageSpire: MissionDefinition = defineMission({
  id: 'vantage-spire',
  order: 10,
  title: 'Vantage Spire',
  brief:
    'The finale. A comms spire rooftop over the night city — the campaign’s '
    + 'largest and most exposed deck. A command defender holds the transmitter core '
    + 'at the far north edge, screened by HVAC rings and antenna masts across a long '
    + 'open approach. Flank the cover in and silence the core.',
  primarySpawnLabel: 'South parapet',
  objective: {
    kind: 'secure',
    title: 'SILENCE THE SPIRE',
    summary: 'Eliminate the command defender and seize the transmitter core.',
    target: [-3, 0, -26],
  },
  createArena: buildVantageSpire,
  enemies: [
    { id: 'spire-command', spawn: arena.enemySpawn, yaw: faceToward(arena.enemySpawn, arena.playerSpawn), coverSolidIds: ['core-obj', 'transmitter', 'antenna-w'] },
  ],
  visual: {
    palette: 'night-cyan comms spire / city rooftop',
    timeOfDay: 'city night',
    loadingBlurb: 'VANTAGE // SPIRE 10',
    accentColor: 0x4fd6ea,
  },
});
