/**
 * Safe level factory for Mission 2 — RELAY BLACKOUT (issue #72, parent #70).
 *
 * `buildRelayArena()` is a pure `ArenaDefinition` that declares NO `container`
 * solids (the relay palette never uses that material). `ArenaLevel`, however,
 * defaults its container dressing ON — the `dressing` URL flag in a browser, or
 * `true` outside one — and that path throws on an empty selection, because
 * `createContainerDressingLayer([])` merges zero geometries
 * (`mergeGeometries([])` → `TypeError`). So the obvious mount,
 *
 *     new ArenaLevel(buildRelayArena(), buildStaticWorld(def))   // DEFAULT options
 *
 * crashes in `init`. That is a real integration footgun: it is invisible until a
 * caller forgets the `{ containerDressing: false }` opt-out.
 *
 * `createRelayLevel` closes it WITHOUT editing any shared file: it ALWAYS
 * resolves `containerDressing` to a concrete boolean via
 * `options.containerDressing ?? false`, so both the default path and an explicit
 * `containerDressing: undefined` mount safely. (An explicit `true` is preserved
 * by the `??` contract — the relay has no containers to dress, so opting dressing
 * on remains the caller's deliberate, and still-throwing, choice.)
 *
 * The shared ROOT CAUSE — `ArenaLevel` defaulting dressing on for a definition
 * that declares no `container` solids — is the parent's to harden; this mission
 * only owns making its own composition safe.
 *
 * `engine.add(createRelayLevel())` is the intended integration; read
 * `.definition` / `.staticWorld` off the returned level to wire the two deploy
 * pads, the enemy spawn and the objective. The typed mission metadata
 * (`playerSpawns`, `objective`, `los`) is available from `buildRelayArena()` in
 * `./index.js` when the parent needs it directly.
 */

import { ArenaLevel, type ArenaLevelOptions } from '../../ArenaLevel.js';
import { buildStaticWorld } from '../../staticWorld.js';
import { buildRelayArena, type RelayArenaDefinition } from './relayArena.js';

/** Options for {@link createRelayLevel}; identical to `ArenaLevelOptions`, but
 *  `containerDressing` is force-resolved to a boolean (default `false`). */
export type RelayLevelOptions = ArenaLevelOptions;

/**
 * Compose Mission 2 as an engine-ready `ArenaLevel` over a freshly built
 * definition + collision world, with the empty-`container` dressing footgun
 * closed. `containerDressing` always resolves through `?? false`, so the level
 * never asks `ArenaLevel` to dress a container the relay does not have.
 */
export function createRelayLevel(options: RelayLevelOptions = {}): ArenaLevel {
  const definition: RelayArenaDefinition = buildRelayArena();
  return new ArenaLevel(definition, buildStaticWorld(definition), {
    ...options,
    containerDressing: options.containerDressing ?? false,
  });
}
