import { buildFoundry } from '../../level/missions/foundry/index.js';
import { asMissionId } from '../ids.js';
import type { MissionDefinition } from '../types.js';

const arena = buildFoundry();

export const foundryLastLight: MissionDefinition = {
  id: asMissionId('foundry-last-light'),
  order: 3,
  title: 'FOUNDRY LAST LIGHT',
  brief:
    'Cross the casting lane under furnace light, climb the west gantry, and break '
    + 'the final defender before securing the shutdown console.',
  objective: {
    kind: 'secure',
    title: 'SECURE THE FOUNDRY',
    summary: arena.finalObjective.detail,
    target: arena.finalObjective.location,
  },
  createArena: buildFoundry,
  playerSpawns: [
    {
      id: 'foundry-west',
      label: 'West casting-lane insertion',
      position: arena.playerSpawns[0],
      yaw: 0,
    },
    {
      id: 'foundry-east',
      label: 'East furnace-lane insertion',
      position: arena.playerSpawns[1],
      yaw: 0,
    },
  ],
  enemies: [{
    id: 'enemy-1',
    spawn: arena.enemySpawn,
    yaw: 0,
    coverSolidIds: arena.enemyCoverIds,
  }],
  completion: { kind: 'eliminate-all-enemies' },
  failure: { kind: 'player-death', retryFrom: 'mission-start' },
  checkpoint: { initial: 'mission-start', banksOnElimination: false },
  visual: {
    palette: 'furnace amber against cool industrial steel',
    timeOfDay: 'last light',
    loadingBlurb: 'DUSKLINE // FOUNDRY LAST LIGHT',
    accentColor: 0xff7a36,
  },
};
