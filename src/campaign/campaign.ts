/**
 * `CampaignRuntime` — the renderer-light orchestrator the parent integration
 * drives once the Relay/Foundry branches land.
 *
 * It composes the pure pieces (catalog, progress machine, deep-link resolver)
 * with the injected effect adapters (persistence, navigation) and an event sink,
 * and does the three things a caller actually needs:
 *
 *  1. **Hydrate** — rebuild progress from a persisted save, or start fresh, with
 *     an explicit `HydrationOutcome` (`fresh`/`restored`/`migrated`/`refused`).
 *     A refused save never forges progress; it degrades to a clean campaign.
 *  2. **Resolve the deep link** — apply a `resolved` link, or keep the frontier
 *     and merely *report* a `locked`/`unknown`/`absent` one. No success fallback.
 *  3. **Advance** — deploy, score eliminations, handle death and replay, then
 *     persist and emit HUD-facing events after every change.
 *
 * It imports no `three`, no DOM, and no sibling subsystem. Every environment
 * effect goes through an adapter, so the whole thing runs and is asserted in
 * plain Node.
 */

import type { ArenaDefinition } from '../level/arena.js';
import type { CampaignCatalog } from './catalog.js';
import type { MissionDefinition, SpawnSlot } from './types.js';
import type { MissionId } from './ids.js';
import type { CampaignPersistenceAdapter, PersistedProgress } from './persistence.js';
import { toSaveData } from './persistence.js';
import type { NavigationAdapter } from './navigation.js';
import type { CampaignEvent, CampaignEventSink, CampaignSnapshot } from './events.js';
import { CampaignEvents, buildCampaignSnapshot } from './events.js';
import type { CampaignProgressState, ProgressTransition } from './progress.js';
import {
  eliminateEnemy,
  initialProgressState,
  playerDied,
  replayMission,
  startMission,
} from './progress.js';
import type { DeepLinkResolution } from './deepLink.js';
import { isDeployable, resolveDeepLink } from './deepLink.js';

export type SpawnIndex = 0 | 1;

export interface CampaignRuntimeOptions {
  readonly catalog: CampaignCatalog;
  readonly persistence: CampaignPersistenceAdapter;
  readonly navigation: NavigationAdapter;
  /** Where HUD-facing events go. Omitted ⇒ events are dropped (still snapshot-able). */
  readonly emit?: CampaignEventSink;
  /** Default insertion slot (0 = primary, 1 = secondary). */
  readonly spawnIndex?: SpawnIndex;
}

export type HydrationStatus = 'fresh' | 'restored' | 'migrated' | 'refused';

export interface HydrationOutcome {
  readonly status: HydrationStatus;
  readonly reason?: string;
}

/** Rebuild live state from a persisted blob, or `null` if it disagrees with the catalog. */
function rehydrateState(
  catalog: CampaignCatalog,
  progress: PersistedProgress,
): CampaignProgressState | null {
  const ids = new Set<string>(catalog.ids);
  const keys = Object.keys(progress.records);
  if (keys.length !== ids.size || !keys.every((k) => ids.has(k))) return null;
  if (progress.currentMissionId !== null && !ids.has(progress.currentMissionId)) return null;
  if (!progress.completedOrder.every((id) => ids.has(id))) return null;

  const records: Record<string, CampaignProgressState['records'][string]> = {};
  for (const key of keys) {
    records[key] = {
      status: progress.records[key].status,
      bankedEliminations: progress.records[key].bankedEliminations,
    };
  }
  return {
    currentMissionId: (progress.currentMissionId as MissionId | null),
    activeEliminations: progress.activeEliminations,
    records,
    completedOrder: progress.completedOrder as readonly MissionId[],
    campaignComplete: progress.campaignComplete,
  };
}

function hydrate(
  catalog: CampaignCatalog,
  persistence: CampaignPersistenceAdapter,
): { state: CampaignProgressState; outcome: HydrationOutcome } {
  const read = persistence.read();
  if (read.status === 'absent') {
    return { state: initialProgressState(catalog), outcome: { status: 'fresh' } };
  }
  if (read.status === 'malformed' || read.status === 'stale-version' || !read.data) {
    return {
      state: initialProgressState(catalog),
      outcome: { status: 'refused', reason: read.reason ?? read.status },
    };
  }
  const rebuilt = rehydrateState(catalog, read.data.progress);
  if (!rebuilt) {
    return {
      state: initialProgressState(catalog),
      outcome: { status: 'refused', reason: 'saved progress does not match this campaign catalog' },
    };
  }
  return {
    state: rebuilt,
    outcome: { status: read.status === 'migrated' ? 'migrated' : 'restored' },
  };
}

export class CampaignRuntime {
  private state: CampaignProgressState;
  private spawnIndex: SpawnIndex;

  private constructor(
    private readonly catalog: CampaignCatalog,
    private readonly persistence: CampaignPersistenceAdapter,
    private readonly navigation: NavigationAdapter,
    private readonly sink: CampaignEventSink | undefined,
    initial: CampaignProgressState,
    spawnIndex: SpawnIndex,
    /** How the save was loaded on construction. */
    readonly hydration: HydrationOutcome,
    /** The deep-link outcome resolved on construction. */
    public deepLink: DeepLinkResolution,
  ) {
    this.state = initial;
    this.spawnIndex = spawnIndex;
  }

  /** Build a runtime: hydrate, resolve the deep link, persist, and return it. */
  static create(options: CampaignRuntimeOptions): CampaignRuntime {
    const { catalog, persistence, navigation } = options;
    const { state, outcome } = hydrate(catalog, persistence);

    const requested = navigation.readRequestedMissionId();
    const resolution = resolveDeepLink(catalog, state, requested);

    const runtime = new CampaignRuntime(
      catalog,
      persistence,
      navigation,
      options.emit,
      state,
      options.spawnIndex ?? 0,
      outcome,
      resolution,
    );

    runtime.emit({ type: CampaignEvents.DeepLinkResolved, resolution });
    if (isDeployable(resolution)) {
      runtime.applyTransitions(startMission(runtime.state, catalog, resolution.missionId));
    }
    runtime.persist();
    return runtime;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  get progressState(): CampaignProgressState {
    return this.state;
  }

  snapshot(): CampaignSnapshot {
    return buildCampaignSnapshot(this.catalog, this.state);
  }

  currentMission(): MissionDefinition | null {
    return this.state.currentMissionId ? this.catalog.byId(this.state.currentMissionId) ?? null : null;
  }

  currentArena(): ArenaDefinition | null {
    return this.state.currentMissionId ? this.catalog.arenaFor(this.state.currentMissionId) : null;
  }

  /** The active insertion slot for `missionId` (defaults to the current mission). */
  spawnSlot(missionId: MissionId | null = this.state.currentMissionId): SpawnSlot | null {
    if (!missionId) return null;
    const mission = this.catalog.byId(missionId);
    return mission ? mission.playerSpawns[this.spawnIndex] : null;
  }

  /** Re-resolve a deep link (defaults to the environment's current request). */
  resolveDeepLink(requested: string | null = this.navigation.readRequestedMissionId()): DeepLinkResolution {
    return resolveDeepLink(this.catalog, this.state, requested);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /** Choose which insertion slot future deploys/retries use. */
  selectSpawn(index: SpawnIndex): void {
    this.spawnIndex = index;
  }

  /** Deploy into a mission (resumes its checkpoint). Rejects a locked mission. */
  deploy(missionId: MissionId): void {
    this.applyTransitions(startMission(this.state, this.catalog, missionId));
    this.navigation.replaceRequestedMissionId(missionId);
    this.persist();
  }

  /** Replay a non-locked mission from a clean start. */
  replay(missionId: MissionId): void {
    this.applyTransitions(replayMission(this.state, this.catalog, missionId));
    this.navigation.replaceRequestedMissionId(missionId);
    this.persist();
  }

  /** Score one defender elimination in the current mission. */
  reportElimination(): void {
    this.applyTransitions(eliminateEnemy(this.state, this.catalog));
    this.persist();
  }

  /** Report a player death; retries the current mission from its checkpoint. */
  reportPlayerDeath(): void {
    this.applyTransitions(playerDied(this.state, this.catalog));
    this.persist();
  }

  /** Follow a resolved deep link by asking the environment to reload into it. */
  requestReloadInto(missionId: MissionId): void {
    this.navigation.requestMission(missionId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private applyTransitions(step: { state: CampaignProgressState; transitions: readonly ProgressTransition[] }): void {
    this.state = step.state;
    for (const transition of step.transitions) {
      const event = this.toEvent(transition);
      if (event) this.emit(event);
    }
  }

  private toEvent(transition: ProgressTransition): CampaignEvent | null {
    switch (transition.kind) {
      case 'mission-started': {
        const mission = this.catalog.byId(transition.missionId);
        const spawn = this.spawnSlot(transition.missionId);
        if (!mission || !spawn) return null;
        return {
          type: CampaignEvents.MissionStarted,
          missionId: transition.missionId,
          order: transition.order,
          title: mission.title,
          spawn,
          resumedEliminations: transition.resumedEliminations,
        };
      }
      case 'enemy-eliminated':
        return {
          type: CampaignEvents.EnemyEliminated,
          missionId: transition.missionId,
          eliminations: transition.eliminations,
          required: transition.required,
          remaining: Math.max(0, transition.required - transition.eliminations),
        };
      case 'checkpoint-banked':
        return {
          type: CampaignEvents.CheckpointBanked,
          missionId: transition.missionId,
          bankedEliminations: transition.bankedEliminations,
        };
      case 'mission-completed':
        return {
          type: CampaignEvents.MissionCompleted,
          missionId: transition.missionId,
          nextMissionId: transition.nextMissionId,
        };
      case 'mission-unlocked':
        return { type: CampaignEvents.MissionUnlocked, missionId: transition.missionId };
      case 'mission-failed': {
        const spawn = this.spawnSlot(transition.missionId);
        if (!spawn) return null;
        return {
          type: CampaignEvents.MissionFailed,
          missionId: transition.missionId,
          resumeEliminations: transition.resumeEliminations,
          spawn,
        };
      }
      case 'campaign-completed':
        return { type: CampaignEvents.CampaignCompleted, completedOrder: transition.completedOrder };
      default: {
        const exhaustive: never = transition;
        return exhaustive;
      }
    }
  }

  private emit(event: CampaignEvent): void {
    this.sink?.(event);
  }

  private persist(): void {
    this.persistence.write(toSaveData(this.state));
  }
}
