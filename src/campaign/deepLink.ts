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
 * mistaken for one because `isDeployable` narrows on `outcome === 'resolved'`.
 *
 * Every variant additionally carries a `fallbackMissionId`: the deterministic
 * mission the caller should normalise a bad/absent link *to* (never deploy into,
 * for the non-resolved outcomes — just the id to show and to rewrite the URL
 * with). It is `defaultMissionId(catalog, state)`: the live frontier mission
 * mid-campaign, or the finale mission once the campaign is complete. This lets a
 * parent rewrite `?mission=locked-or-garbage` to the canonical current mission
 * without the resolver ever pretending the bad link "worked".
 */

import type { CampaignCatalog } from './catalog.js';
import type { CampaignProgressState, MissionStatus } from './progress.js';
import type { MissionId } from './ids.js';
import { tryMissionId } from './ids.js';

export type DeepLinkResolution =
  | { readonly outcome: 'resolved'; readonly missionId: MissionId; readonly order: number; readonly status: MissionStatus; readonly fallbackMissionId: MissionId }
  | { readonly outcome: 'locked'; readonly missionId: MissionId; readonly order: number; readonly blockedBy: MissionId | null; readonly fallbackMissionId: MissionId }
  | { readonly outcome: 'unknown'; readonly requested: string; readonly fallbackMissionId: MissionId }
  | { readonly outcome: 'absent'; readonly fallbackMissionId: MissionId };

/**
 * The deterministic mission a caller should default to / normalise a bad link
 * to: the live frontier mission mid-campaign (`currentMissionId` is non-null for
 * every non-complete state), or the finale mission once the campaign is complete
 * (`currentMissionId` is then `null`). Always returns a real catalog id.
 */
export function defaultMissionId(
  catalog: CampaignCatalog,
  state: CampaignProgressState,
): MissionId {
  return state.currentMissionId ?? catalog.ids[catalog.count - 1];
}

/** Resolve a raw requested id against the catalog and current progress. Pure. */
export function resolveDeepLink(
  catalog: CampaignCatalog,
  state: CampaignProgressState,
  requested: string | null | undefined,
): DeepLinkResolution {
  const fallbackMissionId = defaultMissionId(catalog, state);
  if (requested === null || requested === undefined || requested === '') {
    return { outcome: 'absent', fallbackMissionId };
  }
  const id = tryMissionId(requested);
  if (!id) {
    return { outcome: 'unknown', requested, fallbackMissionId };
  }
  const mission = catalog.byId(id);
  if (!mission) {
    return { outcome: 'unknown', requested, fallbackMissionId };
  }
  const status = state.records[id]?.status ?? 'locked';
  if (status === 'locked') {
    return { outcome: 'locked', missionId: id, order: mission.order, blockedBy: catalog.previousMissionId(id), fallbackMissionId };
  }
  return { outcome: 'resolved', missionId: id, order: mission.order, status, fallbackMissionId };
}

/** Narrow to a deployable deep link. Only `resolved` authorises deployment. */
export function isDeployable(
  resolution: DeepLinkResolution,
): resolution is Extract<DeepLinkResolution, { outcome: 'resolved' }> {
  return resolution.outcome === 'resolved';
}
