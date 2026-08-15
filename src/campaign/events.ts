/**
 * Campaign events and output snapshots — the seam the HUD/integration consumes.
 *
 * The HUD never imports campaign internals and the campaign never imports the
 * HUD. They meet here, on plain data: a `CampaignEvent` discriminated union the
 * runtime emits, and a `CampaignSnapshot` a presenter can render directly. Both
 * are serialisable and free of `three`/DOM, matching the core contract's rule
 * that "presentation never imports gameplay code".
 *
 * The event names mirror the core `Events` naming (`domain:verb`) so a parent
 * that owns the real `EventBus` can forward them by `type` with no translation.
 */

import type { CampaignCatalog } from './catalog.js';
import type { CampaignProgressState, MissionStatus } from './progress.js';
import type { DeepLinkResolution } from './deepLink.js';
import type { MissionId, SpawnSlot } from './types.js';

/** Canonical campaign event names. Named once so nobody invents a second spelling. */
export const CampaignEvents = {
  MissionStarted: 'campaign:mission-started',
  EnemyEliminated: 'campaign:enemy-eliminated',
  CheckpointBanked: 'campaign:checkpoint-banked',
  MissionCompleted: 'campaign:mission-completed',
  MissionUnlocked: 'campaign:mission-unlocked',
  MissionFailed: 'campaign:mission-failed',
  CampaignCompleted: 'campaign:campaign-completed',
  DeepLinkResolved: 'campaign:deep-link-resolved',
} as const;

export type CampaignEvent =
  | {
      readonly type: typeof CampaignEvents.MissionStarted;
      readonly missionId: MissionId;
      readonly order: number;
      readonly title: string;
      /** The insertion slot the player deploys into. */
      readonly spawn: SpawnSlot;
      readonly resumedEliminations: number;
    }
  | {
      readonly type: typeof CampaignEvents.EnemyEliminated;
      readonly missionId: MissionId;
      readonly eliminations: number;
      readonly required: number;
      readonly remaining: number;
    }
  | {
      readonly type: typeof CampaignEvents.CheckpointBanked;
      readonly missionId: MissionId;
      readonly bankedEliminations: number;
    }
  | {
      readonly type: typeof CampaignEvents.MissionCompleted;
      readonly missionId: MissionId;
      readonly nextMissionId: MissionId | null;
    }
  | {
      readonly type: typeof CampaignEvents.MissionUnlocked;
      readonly missionId: MissionId;
    }
  | {
      readonly type: typeof CampaignEvents.MissionFailed;
      readonly missionId: MissionId;
      readonly resumeEliminations: number;
      /** The slot the retry redeploys into. */
      readonly spawn: SpawnSlot;
    }
  | {
      readonly type: typeof CampaignEvents.CampaignCompleted;
      readonly completedOrder: readonly MissionId[];
    }
  | {
      readonly type: typeof CampaignEvents.DeepLinkResolved;
      readonly resolution: DeepLinkResolution;
    };

/** A sink the runtime pushes events into. A parent bridges it to the real bus. */
export type CampaignEventSink = (event: CampaignEvent) => void;

// ── Snapshots ──────────────────────────────────────────────────────────────

/** Bumped if the snapshot *shape* changes, so a HUD can guard against drift. */
export const CAMPAIGN_SNAPSHOT_VERSION = 2;

export interface MissionSnapshot {
  readonly id: MissionId;
  readonly order: number;
  readonly title: string;
  readonly status: MissionStatus;
  /** Long objective sentence (`objective.summary`). */
  readonly objective: string;
  /** Stable HUD objective banner (`objective.title`). */
  readonly objectiveTitle: string;
}

export interface CampaignSnapshot {
  readonly snapshotVersion: number;
  readonly currentMissionId: MissionId | null;
  readonly currentTitle: string | null;
  readonly currentObjective: string | null;
  /** Stable HUD objective banner for the current mission (`objective.title`). */
  readonly currentObjectiveTitle: string | null;
  readonly missions: readonly MissionSnapshot[];
  readonly eliminations: { readonly current: number; readonly required: number; readonly remaining: number } | null;
  readonly campaignComplete: boolean;
  readonly completedCount: number;
  readonly totalCount: number;
  /** Total number of missions in the catalog (alias of `totalCount`, HUD-friendly). */
  readonly missionCount: number;
  /**
   * 0-based index (by order) of the furthest mission the player has reached —
   * the last non-`locked` mission. Unlocks are contiguous, so this is
   * `(count of non-locked missions) - 1`; always ≥ 0 (mission 1 starts open).
   */
  readonly furthestUnlockedIndex: number;
  /** The last mission by order — the campaign's finale. Always a real id. */
  readonly finaleMissionId: MissionId;
}

/** Build the HUD-facing snapshot from the catalog and progress state. Pure. */
export function buildCampaignSnapshot(
  catalog: CampaignCatalog,
  state: CampaignProgressState,
): CampaignSnapshot {
  const missions: MissionSnapshot[] = catalog.missions.map((mission) => ({
    id: mission.id,
    order: mission.order,
    title: mission.title,
    status: state.records[mission.id]?.status ?? 'locked',
    objective: mission.objective.summary,
    objectiveTitle: mission.objective.title,
  }));

  const current = state.currentMissionId ? catalog.byId(state.currentMissionId) : undefined;
  const required = current
    ? current.completion.requiredEliminations ?? current.enemies.length
    : 0;
  const eliminations = current
    ? {
        current: state.activeEliminations,
        required,
        remaining: Math.max(0, required - state.activeEliminations),
      }
    : null;

  const unlockedCount = missions.reduce((n, m) => (m.status === 'locked' ? n : n + 1), 0);
  const finaleMissionId = catalog.ids[catalog.count - 1];

  return {
    snapshotVersion: CAMPAIGN_SNAPSHOT_VERSION,
    currentMissionId: state.currentMissionId,
    currentTitle: current?.title ?? null,
    currentObjective: current?.objective.summary ?? null,
    currentObjectiveTitle: current?.objective.title ?? null,
    missions,
    eliminations,
    campaignComplete: state.campaignComplete,
    completedCount: state.completedOrder.length,
    totalCount: catalog.count,
    missionCount: catalog.count,
    furthestUnlockedIndex: Math.max(0, unlockedCount - 1),
    finaleMissionId,
  };
}
