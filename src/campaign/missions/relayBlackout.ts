import { buildRelayArena } from '../../level/missions/relay/index.js';
import { asMissionId } from '../ids.js';
import type { MissionDefinition } from '../types.js';

const arena = buildRelayArena();

export const relayBlackout: MissionDefinition = {
  id: asMissionId('relay-blackout'),
  order: 2,
  title: 'RELAY BLACKOUT',
  brief: arena.mission.synopsis,
  objective: {
    kind: 'secure',
    title: 'RESTORE THE RELAY',
    summary: 'Push through the switchyard, climb the control deck, and restore the relay.',
    target: arena.objective.position,
  },
  createArena: buildRelayArena,
  playerSpawns: [
    {
      id: arena.playerSpawns[0].name,
      label: 'West switchyard insertion',
      position: arena.playerSpawns[0].position,
      yaw: 0,
    },
    {
      id: arena.playerSpawns[1].name,
      label: 'East switchyard insertion',
      position: arena.playerSpawns[1].position,
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
    palette: 'rain-blue utility metal and cold relay light',
    timeOfDay: 'night',
    loadingBlurb: 'DUSKLINE // RELAY BLACKOUT',
    accentColor: 0x69b8df,
  },
};
