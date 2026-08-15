/**
 * Public surface of Mission 3 — "Foundry Last Light".
 *
 * The parent integrates by calling `buildFoundry()` in place of `buildArena()`
 * and handing the result to the SHARED `ArenaLevel` (untouched), exactly as
 * `src/main.ts` does for the cargo bay. `createFoundryLevel` packages that so
 * the boot path is a one-liner and the second player slot / final objective are
 * available alongside the level, the static world and the definition.
 *
 * Nothing here edits a shared file: it composes the existing level subsystem
 * around a new, contract-compatible definition.
 */

import { ArenaLevel, type ArenaLevelOptions } from '../../ArenaLevel.js';
import { buildStaticWorld } from '../../staticWorld.js';
import type { StaticWorld } from '../../../core/collision.js';
import { buildFoundry, type FoundryArenaDefinition } from './foundry.js';

export { buildFoundry } from './foundry.js';
export type { FoundryArenaDefinition, FinalObjective } from './foundry.js';
export {
  topologyFingerprint,
  compareTopology,
  type TopologyFingerprint,
  type TopologyComparison,
  type FieldComparison,
} from './fingerprint.js';
export {
  segmentIntersectsAABB,
  firstOccluder,
  hasClearLineOfSight,
  type Occluder,
} from './los.js';

export interface FoundryLevel {
  readonly definition: FoundryArenaDefinition;
  readonly staticWorld: StaticWorld;
  readonly level: ArenaLevel;
}

/**
 * Compose the shared `ArenaLevel` around the Foundry definition. The static
 * world is derived once from the same solids the level renders (one-source
 * discipline) and shared with the level so collision and geometry cannot drift.
 *
 * `containerDressing` defaults to `false`: the Foundry authors no
 * `container`-material solids, so the shared cargo-dressing layer has nothing to
 * build (and its merge step throws on an empty selection). A caller may still
 * override any option — including turning dressing back on — via `options`.
 */
export function createFoundryLevel(options: ArenaLevelOptions = {}): FoundryLevel {
  const definition = buildFoundry();
  const staticWorld = buildStaticWorld(definition);
  const level = new ArenaLevel(definition, staticWorld, { containerDressing: false, ...options });
  return { definition, staticWorld, level };
}
