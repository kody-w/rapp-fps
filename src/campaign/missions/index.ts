/**
 * Reviewed, shipping mission adapters.
 *
 * The campaign core is generic: integration builds a catalog by passing an
 * ordered `MissionDefinition[]` to `createCampaignCatalog`. Only **Cargo Breach**
 * ships here today — it adapts the reviewed level `buildArena()` without editing
 * a single level file. The remaining campaign missions are owned by the sibling
 * Relay (boot) and Foundry (level factory) branches; once their PRs merge,
 * integration composes the full list, e.g.
 * `createCampaignCatalog([cargoBreach, relayBlackout, foundryLastLight])`.
 *
 * This module intentionally does NOT export a hardcoded "default campaign": a
 * bundled multi-mission list here would masquerade as the shipping campaign
 * before those definitions are reviewed.
 */

export { cargoBreach, cargoBreachDerivedSpawn } from './cargoBreach.js';

