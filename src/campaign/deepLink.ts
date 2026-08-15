/**
 * Deep-link resolution — the runtime half of "no success fallback".
 *
 * A deep link is an untrusted string (an editable query param). This resolver
 * turns it into an *explicit* discriminated result and nothing else. It never
 * mutates progress, never unlocks, and above all never forges a completion to
 * make a link "work". The four outcomes are exhaustive:
 *
 *  - `absent`   — no link was supplied; the caller uses its default.
 *  - `unknown`  — the string is malformed or names no mission; reported, not honoured.
 *  - `locked`   — the mission exists but its predecessor is unbeaten; reported
 *                 with the blocker, and the caller keeps the player at the frontier.
 *  - `resolved` — the mission exists and is deployable (its current status is returned).
 *
 * The caller decides what to do, but the only outcome that authorises deploying
 * into a chosen mission is `resolved`. `locked`/`unknown`/`absent` can never be
 * mistaken for one because they carry no `missionId` in a `resolved` shape.
 */

import type { CampaignCatalog } from './catalog.js';
import type { CampaignProgressState, MissionStatus } from './progress.js';
import type { MissionId } from './ids.js';
import { tryMissionId } from './ids.js';

export type DeepLinkResolution =
  | { readonly outcome: 'resolved'; readonly missionId: MissionId; readonly order: number; readonly status: MissionStatus }
  | { readonly outcome: 'locked'; readonly missionId: MissionId; readonly order: number; readonly blockedBy: MissionId | null }
  | { readonly outcome: 'unknown'; readonly requested: string }
  | { readonly outcome: 'absent' };

/** Resolve a raw requested id against the catalog and current progress. Pure. */
export function resolveDeepLink(
  catalog: CampaignCatalog,
  state: CampaignProgressState,
  requested: string | null | undefined,
): DeepLinkResolution {
  if (requested === null || requested === undefined || requested === '') {
    return { outcome: 'absent' };
  }
  const id = tryMissionId(requested);
  if (!id) {
    return { outcome: 'unknown', requested };
  }
  const mission = catalog.byId(id);
  if (!mission) {
    return { outcome: 'unknown', requested };
  }
  const status = state.records[id]?.status ?? 'locked';
  if (status === 'locked') {
    return { outcome: 'locked', missionId: id, order: mission.order, blockedBy: catalog.previousMissionId(id) };
  }
  return { outcome: 'resolved', missionId: id, order: mission.order, status };
}

/** Narrow to a deployable deep link. Only `resolved` authorises deployment. */
export function isDeployable(
  resolution: DeepLinkResolution,
): resolution is Extract<DeepLinkResolution, { outcome: 'resolved' }> {
  return resolution.outcome === 'resolved';
}
