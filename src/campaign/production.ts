import type { ArenaDefinition } from '../level/arena.js';
import { createCampaignCatalog, type CampaignCatalog } from './catalog.js';
import {
  cargoBreach,
  foundryLastLight,
  relayBlackout,
} from './missions/index.js';
import type { MissionDefinition } from './types.js';

export const productionMissions = [
  cargoBreach,
  relayBlackout,
  foundryLastLight,
] as const satisfies readonly MissionDefinition[];

export function arenaTopologyFingerprint(arena: ArenaDefinition): string {
  return JSON.stringify({
    solids: arena.solids.map((solid) => ({
      id: solid.id,
      min: solid.min,
      max: solid.max,
      collide: solid.collide,
      material: solid.material,
      surface: solid.surface,
    })),
    playerSpawn: arena.playerSpawn,
    enemySpawn: arena.enemySpawn,
    enemyCoverIds: arena.enemyCoverIds,
    fog: arena.fog,
    lights: arena.lights,
  });
}

export function assertDistinctMissionArenas(
  arenas: readonly ArenaDefinition[],
): void {
  const fingerprints = arenas.map(arenaTopologyFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error('production campaign contains duplicate mission arenas');
  }
}

export function createProductionCampaignCatalog(): CampaignCatalog {
  const catalog = createCampaignCatalog(productionMissions);
  assertDistinctMissionArenas(catalog.ids.map((id) => catalog.arenaFor(id)));
  return catalog;
}
