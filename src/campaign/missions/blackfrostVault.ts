/**
 * Mission 2 — "Blackfrost Vault".
 *
 * A campaign-authored interior (built with `authoring.ts`, not the level's
 * private helpers) that exercises the parts of the contract the one-defender
 * shipping arena cannot: two defenders, so `requiredEliminations > 1`, plus a
 * checkpoint that banks on each elimination and a failure policy that resumes
 * from it — a mid-mission death does not force re-clearing a felled defender.
 */

import { assembleArena, onFloor, roomShell, box } from '../authoring.js';
import { asMissionId } from '../ids.js';
import type { ArenaDefinition, MissionDefinition } from '../types.js';

export function buildBlackfrostVault(): ArenaDefinition {
  const shell = roomShell({
    x: [-9, 9],
    z: [-16, 1],
    wallHeight: 4.5,
    wallMaterial: 'concreteDark',
  });

  const cover = [
    onFloor('vault-pillar', [0, -8], [2.0, 2.0], 2.4, 'concreteDark', 'concrete'),
    onFloor('crate-2a', [-5, -5], [1.4, 1.4], 1.3, 'wood', 'wood'),
    onFloor('crate-2b', [5, -6], [1.4, 1.4], 1.3, 'wood', 'wood'),
    onFloor('barrier-2', [-3, -12], [2.4, 0.7], 1.1, 'concrete', 'concrete'),
    onFloor('vault-door', [4, -12.5], [1.6, 1.6], 1.6, 'darkMetal', 'metal'),
    onFloor('vault-core', [0, -14], [1.4, 1.1], 1.1, 'galvanized', 'metal'),
  ];

  const dressing = [
    box('vault-beacon', [0, 1.6, -15], [0.5, 1.3, 0.5], 'beacon', 'metal', {
      collide: false,
      castShadow: false,
    }),
  ];

  return assembleArena({
    solids: [...shell, ...cover, ...dressing],
    lights: [
      { kind: 'directional', color: 0xbfe0ff, intensity: 2.2, position: [-8, 14, 6], castShadow: true },
      { kind: 'hemisphere', color: 0x6f86b8, groundColor: 0x1c2430, intensity: 0.6 },
      { kind: 'point', color: 0x4fd6ea, intensity: 18, position: [0, 2.1, -15], distance: 12, decay: 2 },
    ],
    shots: [
      {
        name: 'spawn',
        position: [0, 1.7, -0.2],
        lookAt: [0, 1.3, -14],
        caption: 'Blackfrost Vault from the primary insertion: the central pillar splits the approach.',
      },
      {
        name: 'objective',
        position: [0, 1.6, -12.6],
        lookAt: [0, 1.2, -0.5],
        caption: 'The vault core, looking back toward the two insertion slots.',
      },
    ],
    playerSpawn: [0, 0, -0.4],
    enemySpawn: [-4, 0, -10],
    enemyCoverIds: ['vault-pillar', 'barrier-2', 'vault-door', 'crate-2a'],
    fog: { color: 0x121a26, density: 0.03 },
  });
}

export const blackfrostVault: MissionDefinition = {
  id: asMissionId('blackfrost-vault'),
  order: 2,
  title: 'Blackfrost Vault',
  brief:
    'Two defenders hold a cold vault interior — one on the pillar line, one on the '
    + 'vault door. Bank the first kill before you push the core; a clean death '
    + 'resumes from that checkpoint, not the door.',
  objective: {
    kind: 'secure',
    summary: 'Clear both defenders and secure the vault core.',
    target: [0, 0, -14],
  },
  createArena: buildBlackfrostVault,
  playerSpawns: [
    { id: 'insertion-primary', label: 'Primary insertion', position: [0, 0, -0.4], yaw: 0 },
    { id: 'insertion-secondary', label: 'Flank insertion', position: [-3.4, 0, -0.4], yaw: 0 },
  ],
  enemies: [
    { id: 'defender-pillar', spawn: [-4, 0, -10], yaw: 0, coverSolidIds: ['vault-pillar', 'barrier-2'] },
    { id: 'defender-door', spawn: [4, 0, -11], yaw: 0, coverSolidIds: ['vault-door', 'vault-pillar'] },
  ],
  completion: { kind: 'eliminate-all-enemies' },
  failure: { kind: 'player-death', retryFrom: 'last-checkpoint' },
  checkpoint: { initial: 'mission-start', banksOnElimination: true },
  visual: {
    palette: 'cold steel and frost blue',
    timeOfDay: 'interior night',
    loadingBlurb: 'DUSKLINE // BLACKFROST VAULT',
    accentColor: 0x9fdfff,
  },
};
