/**
 * `MissionId` — a validated, branded string.
 *
 * Deep links arrive as raw, untrusted strings (a query param a player can edit).
 * The whole campaign refuses to treat such a string as a mission until it has
 * been checked, so `MissionId` is *branded*: an arbitrary `string` is not
 * assignable to it, and the only way to mint one is `asMissionId`, which throws
 * on a malformed id, or `tryMissionId`, which returns `null`. The catalog then
 * confirms the id actually names a mission. This is the type-level half of the
 * "no success fallback" rule (`deepLink.ts` is the runtime half): a forged id
 * cannot silently flow into progress as if it were real.
 */

declare const missionIdBrand: unique symbol;

/** A kebab-case mission identifier that has passed `asMissionId`. */
export type MissionId = string & { readonly [missionIdBrand]: 'MissionId' };

/** kebab-case: lowercase letters/digits in words joined by single hyphens. */
export const MISSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True if `raw` is a well-formed mission id (shape only; not catalog membership). */
export function isMissionId(raw: string): raw is MissionId {
  return MISSION_ID_PATTERN.test(raw);
}

/** Brand `raw` as a `MissionId`, throwing if it is not kebab-case. */
export function asMissionId(raw: string): MissionId {
  if (!isMissionId(raw)) {
    throw new TypeError(
      `invalid mission id ${JSON.stringify(raw)}: expected kebab-case (e.g. "cargo-breach")`,
    );
  }
  return raw;
}

/** Brand `raw` as a `MissionId`, or return `null` if it is malformed. */
export function tryMissionId(raw: string | null | undefined): MissionId | null {
  if (typeof raw !== 'string' || !isMissionId(raw)) return null;
  return raw;
}
