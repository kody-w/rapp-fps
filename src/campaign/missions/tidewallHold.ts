/**
 * Mission 3 — "Tidewall Hold" (finale).
 *
 * A campaign-authored seawall bunker and the campaign's terminal mission:
 * completing it drives the progress machine to `campaignComplete`. Two defenders
 * again, but the finale is unforgiving — the failure policy retries from the
 * mission start, so `banksOnElimination` is off and a death re-clears the hold.
 */

import { assembleArena, box, onFloor, roomShell } from '../authoring.js';
import { asMissionId } from '../ids.js';
import type { ArenaDefinition, MissionDefinition } from '../types.js';

export function buildTidewallHold(): ArenaDefinition {
  const shell = roomShell({
    x: [-10, 10],
    z: [-18, 1],
    wallHeight: 5.0,
    wallMaterial: 'concrete',
  });

  const cover = [
    onFloor('bunker-3', [0, -9], [3.0, 2.2], 2.2, 'concrete', 'concrete'),
    onFloor('sandbag-3w', [-6, -6], [2.6, 0.8], 1.0, 'concreteDark', 'concrete'),
    onFloor('sandbag-3e', [6, -7], [2.6, 0.8], 1.0, 'concreteDark', 'concrete'),
    onFloor('crate-3', [-4, -13], [1.5, 1.5], 1.4, 'wood', 'wood'),
    onFloor('seawall-3', [3, -14], [3.0, 0.9], 1.2, 'concrete', 'concrete'),
  ];

  const dressing = [
    box('tide-beacon', [0, 1.55, -16.5], [0.5, 1.2, 0.5], 'beacon', 'metal', {
      collide: false,
      castShadow: false,
    }),
  ];

  return assembleArena({
    solids: [...shell, ...cover, ...dressing],
    lights: [
      { kind: 'directional', color: 0xffe6c4, intensity: 2.4, position: [-8, 14, 6], castShadow: true },
      { kind: 'hemisphere', color: 0x7d97c6, groundColor: 0x2a2219, intensity: 0.62 },
      { kind: 'point', color: 0x4fd6ea, intensity: 16, position: [0, 2.0, -16.5], distance: 10, decay: 2 },
    ],
    shots: [
      {
        name: 'spawn',
        position: [0, 1.7, -0.2],
        lookAt: [0, 1.3, -16],
        caption: 'Tidewall Hold from insertion: sandbag lines flank the central bunker.',
      },
      {
        name: 'objective',
        position: [0, 1.6, -14.5],
        lookAt: [0, 1.2, -0.5],
        caption: 'The seawall objective, looking back across the hold.',
      },
    ],
    playerSpawn: [0, 0, -0.4],
    enemySpawn: [-3, 0, -12],
    enemyCoverIds: ['bunker-3', 'crate-3', 'seawall-3', 'sandbag-3w'],
    fog: { color: 0x1b2735, density: 0.028 },
  });
}

export const tidewallHold: MissionDefinition = {
  id: asMissionId('tidewall-hold'),
  order: 3,
  title: 'Tidewall Hold',
  brief:
    'The finale. Two defenders dug into a seawall bunker guard the tide beacon. No '
    + 'mid-mission checkpoint — a death sends you back to the water line. Clear the '
    + 'hold to end the campaign.',
  objective: {
    kind: 'reach',
    summary: 'Break the seawall hold and reach the tide beacon.',
    target: [0, 0, -16.5],
  },
  createArena: buildTidewallHold,
  playerSpawns: [
    { id: 'insertion-primary', label: 'Primary insertion', position: [0, 0, -0.4], yaw: 0 },
    { id: 'insertion-secondary', label: 'East insertion', position: [3.6, 0, -0.4], yaw: 0 },
  ],
  enemies: [
    { id: 'defender-bunker', spawn: [-3, 0, -12], yaw: 0, coverSolidIds: ['bunker-3', 'crate-3'] },
    { id: 'defender-seawall', spawn: [4, 0, -13], yaw: 0, coverSolidIds: ['seawall-3', 'bunker-3'] },
  ],
  completion: { kind: 'eliminate-all-enemies' },
  failure: { kind: 'player-death', retryFrom: 'mission-start' },
  checkpoint: { initial: 'mission-start', banksOnElimination: false },
  visual: {
    palette: 'dusk concrete and teal tide light',
    timeOfDay: 'dusk',
    loadingBlurb: 'DUSKLINE // TIDEWALL HOLD',
    accentColor: 0x4fd6ea,
  },
};
