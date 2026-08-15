/**
 * Public surface of the campaign library.
 *
 * This is a **renderer-light contract**: a parent integration can build the
 * catalog, run the progression, resolve deep links, and persist progress without
 * importing `three`, the DOM, or any not-yet-existing Relay/Foundry branch. The
 * one dependency into the rest of the codebase is the level's pure
 * `ArenaDefinition` type (re-exported below), which every mission's `createArena`
 * returns — the same type the shipping level already produces.
 *
 * Typical wiring, once the sibling Relay/Foundry branches land, integration
 * composes the reviewed mission list (Cargo Breach ships here; the others arrive
 * from those branches):
 *
 * ```ts
 * import {
 *   createCampaignCatalog, cargoBreach, CampaignRuntime,
 *   createLocalStoragePersistence, createQueryNavigation,
 * } from './campaign/index.js';
 *
 * const catalog = createCampaignCatalog([cargoBreach, relayBlackout, foundryLastLight]);
 * const runtime = CampaignRuntime.create({
 *   catalog,
 *   persistence: createLocalStoragePersistence(window.localStorage),
 *   navigation: createQueryNavigation({ getSearch, setSearch, reload }),
 *   emit: (e) => bus.emit(e.type, e), // bridge to the core EventBus
 * });
 * const arena = runtime.currentArena();   // hand to the Foundry/level factory
 * const spawn = runtime.spawnSlot();      // hand to the player system
 * ```
 */

// ── Contract types ──────────────────────────────────────────────────────────
export type {
  MissionDefinition,
  MissionObjective,
  SpawnSlot,
  EnemyPlacement,
  CompletionPolicy,
  FailurePolicy,
  CheckpointPolicy,
  MissionVisualMetadata,
  ArenaDefinition,
  Vec3,
} from './types.js';
export type { MissionId } from './ids.js';
export { asMissionId, tryMissionId, isMissionId, MISSION_ID_PATTERN } from './ids.js';

// ── Spawn geometry ────────────────────────────────────────────────────────
export {
  deriveClearFloorSpawn,
  evaluateClearance,
  isSpawnClear,
  standsOnFloor,
  isFloorSlab,
  interiorFootprint,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_STANDING_HEIGHT,
  FLOOR_SURFACE_EPS,
} from './spawns.js';
export type { ClearanceResult, ClearanceOptions, DerivedSpawn, DeriveSpawnOptions } from './spawns.js';

// ── Reviewed missions & catalog ─────────────────────────────────────────────
// Cargo Breach is the only reviewed mission that ships here; integration adds
// the sibling Relay/Foundry definitions to the catalog once their PRs merge.
export { cargoBreach, cargoBreachDerivedSpawn } from './missions/index.js';
export { createCampaignCatalog, CampaignValidationError } from './catalog.js';
export type { CampaignCatalog, CampaignValidationCode } from './catalog.js';

// ── Progression state machine ───────────────────────────────────────────────
export {
  CampaignProgress,
  CampaignProgressError,
  initialProgressState,
  startMission,
  replayMission,
  eliminateEnemy,
  playerDied,
} from './progress.js';
export type {
  MissionStatus,
  MissionProgressRecord,
  CampaignProgressState,
  ProgressTransition,
  ProgressStep,
} from './progress.js';

// ── Deep links ──────────────────────────────────────────────────────────────
export { resolveDeepLink, isDeployable, defaultMissionId } from './deepLink.js';
export type { DeepLinkResolution } from './deepLink.js';

// ── Events & snapshots (HUD-facing) ─────────────────────────────────────────
export { CampaignEvents, CAMPAIGN_SNAPSHOT_VERSION, buildCampaignSnapshot } from './events.js';
export type { CampaignEvent, CampaignEventSink, MissionSnapshot, CampaignSnapshot } from './events.js';

// ── Persistence ─────────────────────────────────────────────────────────────
export {
  parseCampaignSave,
  toSaveData,
  createLocalStoragePersistence,
  createInMemoryPersistence,
  MemoryKeyValueStore,
  CAMPAIGN_SCHEMA_VERSION,
  DEFAULT_PERSISTENCE_KEY,
} from './persistence.js';
export type {
  CampaignPersistenceAdapter,
  CampaignSaveData,
  PersistedProgress,
  PersistenceReadResult,
  PersistenceReadStatus,
  KeyValueStore,
} from './persistence.js';

// ── Navigation ──────────────────────────────────────────────────────────────
export { InMemoryNavigation, createQueryNavigation } from './navigation.js';
export type { NavigationAdapter, LocationSeam } from './navigation.js';

// ── Runtime orchestrator ────────────────────────────────────────────────────
export { CampaignRuntime } from './campaign.js';
export type {
  CampaignRuntimeOptions,
  HydrationOutcome,
  HydrationStatus,
  SpawnIndex,
} from './campaign.js';
