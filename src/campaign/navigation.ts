/**
 * Navigation / reload adapter — so a test never touches `window.location`.
 *
 * Deep links live in the URL, and following one may reload the page. Both are
 * environment effects the campaign must not perform directly, or its logic could
 * only be exercised in a browser. So it depends on this narrow interface. Tests
 * inject `InMemoryNavigation` and assert what *would* have happened
 * (`reloadRequests`, `replacements`) without any real navigation.
 *
 * Production wires `createQueryNavigation` to a `LocationSeam` backed by the real
 * `location`/`history` later — that seam is functions only, so even the query
 * implementation here imports no DOM and loads in Node.
 */

import type { MissionId } from './ids.js';

export interface NavigationAdapter {
  /** The requested deep-link mission id from the environment, or `null`. */
  readRequestedMissionId(): string | null;
  /** Follow a deep link: point the environment at `missionId` and (re)load it. */
  requestMission(missionId: MissionId): void;
  /** Update the deep link WITHOUT reloading (e.g. reflect the resolved default). */
  replaceRequestedMissionId(missionId: MissionId | null): void;
}

/** Test double: records intent instead of navigating. */
export class InMemoryNavigation implements NavigationAdapter {
  private requested: string | null;
  readonly reloadRequests: MissionId[] = [];
  readonly replacements: (MissionId | null)[] = [];

  constructor(requested: string | null = null) {
    this.requested = requested;
  }

  readRequestedMissionId(): string | null {
    return this.requested;
  }

  requestMission(missionId: MissionId): void {
    this.reloadRequests.push(missionId);
    this.requested = missionId;
  }

  replaceRequestedMissionId(missionId: MissionId | null): void {
    this.replacements.push(missionId);
    this.requested = missionId;
  }
}

/**
 * The seam a parent supplies to bind real navigation without the campaign ever
 * importing `location`/`history`. All functions; entirely browser-free here.
 */
export interface LocationSeam {
  /** The current query string, including a leading `?` if present. */
  getSearch(): string;
  /** Replace the query string without reloading (e.g. `history.replaceState`). */
  setSearch(next: string): void;
  /** Reload the document (e.g. `location.reload()`). */
  reload(): void;
}

/**
 * A `NavigationAdapter` backed by a URL query parameter. Uses `URLSearchParams`
 * (a Node + browser global), so it is browser-free at import; the DOM effects
 * are confined to the injected `LocationSeam`.
 */
export function createQueryNavigation(seam: LocationSeam, param = 'mission'): NavigationAdapter {
  const params = (): URLSearchParams => new URLSearchParams(seam.getSearch());
  return {
    readRequestedMissionId: () => params().get(param),
    requestMission: (missionId) => {
      const next = params();
      next.set(param, missionId);
      seam.setSearch(`?${next.toString()}`);
      seam.reload();
    },
    replaceRequestedMissionId: (missionId) => {
      const next = params();
      if (missionId === null) next.delete(param);
      else next.set(param, missionId);
      const query = next.toString();
      seam.setSearch(query ? `?${query}` : '');
    },
  };
}
