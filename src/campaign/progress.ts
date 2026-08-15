/**
 * `CampaignProgress` — the pure progression state machine.
 *
 * This is deliberately renderer-, storage- and navigation-free: it is a set of
 * pure reducers over an immutable, JSON-shaped `CampaignProgressState`, plus a
 * thin stateful `CampaignProgress` wrapper for ergonomics. Every operation
 * returns the *transitions* it caused so the runtime can translate them into
 * HUD-facing events without the machine ever knowing an event bus exists.
 *
 * The modelled rules:
 *  - a mission is `locked` until its predecessor is `completed`; mission 1 never locks;
 *  - exactly one mission is `current` unless the whole campaign is complete;
 *  - the current mission's defenders eliminate one at a time; reaching the
 *    required count completes it, unlocks the next, and advances the pointer;
 *  - completing the final mission sets `campaignComplete` and clears the pointer;
 *  - a player death retries the current mission from its checkpoint (mission
 *    start, or the last banked elimination), never re-locking later missions;
 *  - `replay` re-deploys any non-locked mission from a clean start without
 *    erasing progress already earned elsewhere.
 *
 * The state is intentionally serialisable so persistence can store it verbatim
 * under a schema version (`persistence.ts`).
 */

import type { CampaignCatalog } from './catalog.js';
import type { MissionDefinition } from './types.js';
import type { MissionId } from './ids.js';

export type MissionStatus = 'locked' | 'unlocked' | 'current' | 'completed';

export interface MissionProgressRecord {
  readonly status: MissionStatus;
  /** Eliminations a death will resume to (the mission's banked checkpoint). */
  readonly bankedEliminations: number;
}

export interface CampaignProgressState {
  readonly currentMissionId: MissionId | null;
  /** Eliminations in the current mission for this life-run (reset on death/replay). */
  readonly activeEliminations: number;
  readonly records: Readonly<Record<string, MissionProgressRecord>>;
  /** Missions beaten, in completion order (deduplicated). */
  readonly completedOrder: readonly MissionId[];
  readonly campaignComplete: boolean;
}

export type ProgressTransition =
  | { readonly kind: 'mission-started'; readonly missionId: MissionId; readonly order: number; readonly resumedEliminations: number }
  | { readonly kind: 'enemy-eliminated'; readonly missionId: MissionId; readonly eliminations: number; readonly required: number }
  | { readonly kind: 'checkpoint-banked'; readonly missionId: MissionId; readonly bankedEliminations: number }
  | { readonly kind: 'mission-completed'; readonly missionId: MissionId; readonly nextMissionId: MissionId | null }
  | { readonly kind: 'mission-unlocked'; readonly missionId: MissionId }
  | { readonly kind: 'mission-failed'; readonly missionId: MissionId; readonly resumeEliminations: number }
  | { readonly kind: 'campaign-completed'; readonly completedOrder: readonly MissionId[] };

export interface ProgressStep {
  readonly state: CampaignProgressState;
  readonly transitions: readonly ProgressTransition[];
}

export class CampaignProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignProgressError';
  }
}

function requiredEliminations(mission: MissionDefinition): number {
  return mission.completion.requiredEliminations ?? mission.enemies.length;
}

/** The fresh state for a catalog: mission 1 current, the rest locked. */
export function initialProgressState(catalog: CampaignCatalog): CampaignProgressState {
  const records: Record<string, MissionProgressRecord> = {};
  for (const mission of catalog.missions) {
    records[mission.id] = {
      status: mission.order === 1 ? 'current' : 'locked',
      bankedEliminations: 0,
    };
  }
  return {
    currentMissionId: catalog.firstMissionId,
    activeEliminations: 0,
    records,
    completedOrder: [],
    campaignComplete: false,
  };
}

// ── Immutable draft helpers ────────────────────────────────────────────────

interface Draft {
  currentMissionId: MissionId | null;
  activeEliminations: number;
  records: Record<string, MissionProgressRecord>;
  completedOrder: MissionId[];
  campaignComplete: boolean;
}

function toDraft(state: CampaignProgressState): Draft {
  const records: Record<string, MissionProgressRecord> = {};
  for (const [id, rec] of Object.entries(state.records)) records[id] = { ...rec };
  return {
    currentMissionId: state.currentMissionId,
    activeEliminations: state.activeEliminations,
    records,
    completedOrder: [...state.completedOrder],
    campaignComplete: state.campaignComplete,
  };
}

function freeze(draft: Draft): CampaignProgressState {
  return {
    currentMissionId: draft.currentMissionId,
    activeEliminations: draft.activeEliminations,
    records: draft.records,
    completedOrder: draft.completedOrder,
    campaignComplete: draft.campaignComplete,
  };
}

function setStatus(draft: Draft, id: MissionId, status: MissionStatus): void {
  draft.records[id] = { ...draft.records[id], status };
}

function setBanked(draft: Draft, id: MissionId, banked: number): void {
  draft.records[id] = { ...draft.records[id], bankedEliminations: banked };
}

function demotePrevious(draft: Draft, keep: MissionId): void {
  const prev = draft.currentMissionId;
  if (prev && prev !== keep && draft.records[prev]?.status === 'current') {
    setStatus(draft, prev, draft.completedOrder.includes(prev) ? 'completed' : 'unlocked');
  }
}

/** The lowest-order mission not yet completed, or `null` if all are done. */
function frontier(draft: Draft, catalog: CampaignCatalog): MissionId | null {
  for (const mission of catalog.missions) {
    if (draft.records[mission.id].status !== 'completed') return mission.id;
  }
  return null;
}

// ── Pure reducers ──────────────────────────────────────────────────────────

/** Deploy into `missionId` and resume its checkpoint. Rejects a locked mission. */
export function startMission(
  state: CampaignProgressState,
  catalog: CampaignCatalog,
  missionId: MissionId,
): ProgressStep {
  const mission = catalog.byId(missionId);
  if (!mission) throw new CampaignProgressError(`unknown mission "${missionId}"`);
  const draft = toDraft(state);
  if (draft.records[missionId].status === 'locked') {
    throw new CampaignProgressError(`cannot start locked mission "${missionId}"`);
  }
  demotePrevious(draft, missionId);
  setStatus(draft, missionId, 'current');
  draft.currentMissionId = missionId;
  // A live mission and a complete campaign are mutually exclusive: re-entering a
  // mission after the finale (deploy/replay) reopens the campaign.
  draft.campaignComplete = false;
  draft.activeEliminations = draft.records[missionId].bankedEliminations;
  return {
    state: freeze(draft),
    transitions: [{
      kind: 'mission-started',
      missionId,
      order: mission.order,
      resumedEliminations: draft.activeEliminations,
    }],
  };
}

/** Re-deploy `missionId` from a clean start (clears its checkpoint only). */
export function replayMission(
  state: CampaignProgressState,
  catalog: CampaignCatalog,
  missionId: MissionId,
): ProgressStep {
  const mission = catalog.byId(missionId);
  if (!mission) throw new CampaignProgressError(`unknown mission "${missionId}"`);
  const draft = toDraft(state);
  if (draft.records[missionId].status === 'locked') {
    throw new CampaignProgressError(`cannot replay locked mission "${missionId}"`);
  }
  demotePrevious(draft, missionId);
  setBanked(draft, missionId, 0);
  setStatus(draft, missionId, 'current');
  draft.currentMissionId = missionId;
  // As with startMission: replaying (even the finale) reopens the campaign, so a
  // current mission can never coexist with campaignComplete.
  draft.campaignComplete = false;
  draft.activeEliminations = 0;
  return {
    state: freeze(draft),
    transitions: [{ kind: 'mission-started', missionId, order: mission.order, resumedEliminations: 0 }],
  };
}

function completeCurrent(
  draft: Draft,
  catalog: CampaignCatalog,
  transitions: ProgressTransition[],
): void {
  const cur = draft.currentMissionId;
  if (!cur) return;
  const wasCompleted = draft.completedOrder.includes(cur);
  setStatus(draft, cur, 'completed');
  if (!wasCompleted) draft.completedOrder.push(cur);

  const next = catalog.nextMissionId(cur);
  transitions.push({ kind: 'mission-completed', missionId: cur, nextMissionId: next });
  if (next && draft.records[next].status === 'locked') {
    setStatus(draft, next, 'unlocked');
    transitions.push({ kind: 'mission-unlocked', missionId: next });
  }

  const wasComplete = draft.campaignComplete;
  const front = frontier(draft, catalog);
  if (front) {
    setStatus(draft, front, 'current');
    draft.currentMissionId = front;
    draft.activeEliminations = draft.records[front].bankedEliminations;
  } else {
    draft.currentMissionId = null;
    draft.campaignComplete = true;
    if (!wasComplete) {
      transitions.push({ kind: 'campaign-completed', completedOrder: [...draft.completedOrder] });
    }
  }
}

/** One defender down in the current mission; may complete it and cascade. */
export function eliminateEnemy(
  state: CampaignProgressState,
  catalog: CampaignCatalog,
): ProgressStep {
  const cur = state.currentMissionId;
  if (!cur) throw new CampaignProgressError('no current mission to score an elimination against');
  const mission = catalog.byId(cur);
  if (!mission) throw new CampaignProgressError(`unknown current mission "${cur}"`);
  const required = requiredEliminations(mission);
  const draft = toDraft(state);
  const transitions: ProgressTransition[] = [];

  if (draft.activeEliminations >= required) {
    // Already cleared this run; scoring again is a no-op rather than an error.
    return { state, transitions };
  }
  draft.activeEliminations += 1;
  transitions.push({
    kind: 'enemy-eliminated',
    missionId: cur,
    eliminations: draft.activeEliminations,
    required,
  });
  if (mission.checkpoint.banksOnElimination) {
    setBanked(draft, cur, draft.activeEliminations);
    transitions.push({ kind: 'checkpoint-banked', missionId: cur, bankedEliminations: draft.activeEliminations });
  }
  if (draft.activeEliminations >= required) {
    completeCurrent(draft, catalog, transitions);
  }
  return { state: freeze(draft), transitions };
}

/** Player death: retry the current mission from its checkpoint. */
export function playerDied(
  state: CampaignProgressState,
  catalog: CampaignCatalog,
): ProgressStep {
  const cur = state.currentMissionId;
  if (!cur) throw new CampaignProgressError('no current mission to fail');
  const mission = catalog.byId(cur);
  if (!mission) throw new CampaignProgressError(`unknown current mission "${cur}"`);
  const draft = toDraft(state);
  const resume = mission.failure.retryFrom === 'mission-start'
    ? 0
    : draft.records[cur].bankedEliminations;
  draft.activeEliminations = resume;
  if (mission.failure.retryFrom === 'mission-start') {
    setBanked(draft, cur, 0);
  }
  return {
    state: freeze(draft),
    transitions: [{ kind: 'mission-failed', missionId: cur, resumeEliminations: resume }],
  };
}

/**
 * Stateful ergonomic wrapper. Holds the current state, applies the pure
 * reducers, and accumulates the transitions from the last call. The reducers
 * remain the source of truth and are independently testable.
 */
export class CampaignProgress {
  private current: CampaignProgressState;

  constructor(private readonly catalog: CampaignCatalog, initial?: CampaignProgressState) {
    this.current = initial ?? initialProgressState(catalog);
  }

  get state(): CampaignProgressState {
    return this.current;
  }

  private apply(step: ProgressStep): readonly ProgressTransition[] {
    this.current = step.state;
    return step.transitions;
  }

  start(missionId: MissionId): readonly ProgressTransition[] {
    return this.apply(startMission(this.current, this.catalog, missionId));
  }

  replay(missionId: MissionId): readonly ProgressTransition[] {
    return this.apply(replayMission(this.current, this.catalog, missionId));
  }

  eliminate(): readonly ProgressTransition[] {
    return this.apply(eliminateEnemy(this.current, this.catalog));
  }

  die(): readonly ProgressTransition[] {
    return this.apply(playerDied(this.current, this.catalog));
  }

  status(missionId: MissionId): MissionStatus | undefined {
    return this.current.records[missionId]?.status;
  }
}
