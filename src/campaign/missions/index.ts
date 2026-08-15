/**
 * The default three-mission campaign, in order.
 *
 * Integration passes this array to `createCampaignCatalog`. It is exported as a
 * factory so a caller gets a fresh, ungimmicked list (the mission objects
 * themselves are immutable data).
 */

import type { MissionDefinition } from '../types.js';
import { cargoBreach } from './cargoBreach.js';
import { blackfrostVault } from './blackfrostVault.js';
import { tidewallHold } from './tidewallHold.js';

export { cargoBreach, cargoBreachDerivedSpawn } from './cargoBreach.js';
export { blackfrostVault, buildBlackfrostVault } from './blackfrostVault.js';
export { tidewallHold, buildTidewallHold } from './tidewallHold.js';

/** The shipping campaign: Cargo Breach → Blackfrost Vault → Tidewall Hold. */
export function defaultCampaignMissions(): readonly MissionDefinition[] {
  return [cargoBreach, blackfrostVault, tidewallHold];
}
