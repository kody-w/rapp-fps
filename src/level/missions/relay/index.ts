/**
 * Public surface of Mission 2 — RELAY BLACKOUT.
 *
 * The parent campaign integrates the mission by importing the pure factory and
 * its metadata types from here; the topology fingerprint + sightline helpers are
 * exported for the committed comparison test and any future mission-selection UI.
 * Nothing here touches a shared file: `ArenaLevel` already accepts an injected
 * `ArenaDefinition`, and `RelayArenaDefinition` is assignable to it.
 *
 * Prefer `createRelayLevel()` to mount the mission: `buildRelayArena()` declares
 * no `container` solids, and `ArenaLevel`'s container dressing defaults ON — a
 * path that THROWS on that empty selection — so a raw
 * `new ArenaLevel(buildRelayArena(), ...)` crashes unless the caller remembers
 * `{ containerDressing: false }`. The factory resolves that safely for you.
 */

export { createRelayLevel } from './relayLevel.js';
export type { RelayLevelOptions } from './relayLevel.js';
export { buildRelayArena } from './relayArena.js';
export type {
  RelayArenaDefinition,
  RelayMissionMeta,
  RelayObjective,
  RelaySpawnSlot,
  RelayLosPolicy,
} from './relayArena.js';
export {
  computeTopologyFingerprint,
  compareTopology,
  segmentIntersectsAABB,
  segmentBlocked,
} from './topology.js';
export type {
  TopologyFingerprint,
  TopologyComparison,
  TopologyBounds,
  RouteSignature,
  SightlineSignature,
  SightlineOptions,
} from './topology.js';
