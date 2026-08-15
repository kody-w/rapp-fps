/**
 * The campaign mission contract.
 *
 * This is the single seam the parent integration plugs into once the Relay
 * (boot/scene) and Foundry (level factory) branches land. It is deliberately
 * **renderer-light**: nothing here imports `three`, the DOM, or any sibling
 * subsystem. A `MissionDefinition` is plain, serialisable-ish data plus one
 * function — `createArena` — whose return type (`ArenaDefinition`) is the exact
 * type the shipping level already produces. That means a mission can be defined,
 * validated and its progression simulated in Node, with no browser, before a
 * single pixel exists.
 *
 * A definition owns geometry-adjacent facts (spawns, cover, objective) and
 * *policy* (how the mission completes, fails and checkpoints). It does NOT own
 * runtime wiring: it never reaches for a bus, a renderer or `location`. Those
 * arrive by injection at the `campaign.ts` layer.
 */

import type { ArenaDefinition, Vec3 } from '../level/arena.js';
import type { MissionId } from './ids.js';

export type { MissionId } from './ids.js';
export type { ArenaDefinition, Vec3 } from '../level/arena.js';

/**
 * One floor-based insertion point for the player capsule.
 *
 * `position` is the capsule *feet* (eye height is owned by the player system,
 * exactly as `ArenaDefinition.playerSpawn` documents), so a floor spawn has
 * `position[1] === 0`. Every slot is validated to actually stand clear of the
 * mission's collidable solids (`spawns.ts`) — a spawn is never a point the
 * author merely asserted was empty.
 */
export interface SpawnSlot {
  /** Stable id, unique within the mission (e.g. `insertion-a`). */
  readonly id: string;
  /** Human label for a briefing/HUD ("Primary insertion"). */
  readonly label: string;
  /** Feet position in arena space; `y` must be the floor (0). */
  readonly position: Vec3;
  /** Facing yaw in radians (0 = −Z, the arena's objective direction). */
  readonly yaw: number;
}

/**
 * Where a defender starts and what authored cover it may hold.
 *
 * `coverSolidIds` index into `createArena().solids`; every id must name a solid
 * that exists AND collides — cover the player cannot trust is exactly the
 * failure this whole codebase refuses. The catalog proves it against the real
 * arena, not by assertion.
 */
export interface EnemyPlacement {
  readonly id: string;
  /** Ground/feet position of the defender. */
  readonly spawn: Vec3;
  readonly yaw: number;
  /** Authored solids this defender may rank as cover; each must collide. */
  readonly coverSolidIds: readonly string[];
}

/** What the player is trying to do; drives the HUD objective line. */
export interface MissionObjective {
  /**
   * `eliminate` — clear the defenders (completion is elimination-driven).
   * `reach` / `secure` — get to / hold `target` (still elimination-gated in the
   * slice, but the intent is authored for a future trigger volume).
   */
  readonly kind: 'eliminate' | 'reach' | 'secure';
  /**
   * Stable, short objective banner the production HUD renders verbatim (e.g.
   * `SECURE THE CARGO BAY`). Distinct from `summary`: `title` is the fixed HUD
   * headline; `summary` is the longer briefing sentence. Must be non-empty.
   */
  readonly title: string;
  /** One-line objective shown to the player; must be non-empty. */
  readonly summary: string;
  /** Optional world point for `reach`/`secure` objectives. */
  readonly target?: Vec3;
}

/**
 * How a mission is considered complete.
 *
 * The slice is elimination-driven: `requiredEliminations` defenders must fall.
 * It defaults (in the catalog) to the placement count, and must stay within
 * `[1, enemies.length]` — an "invalid progression" the catalog rejects.
 */
export interface CompletionPolicy {
  readonly kind: 'eliminate-all-enemies' | 'reach-objective';
  /** Defenders required down; omitted ⇒ every placement. */
  readonly requiredEliminations?: number;
}

/** What a player death does. The slice retries in place, honouring checkpoints. */
export interface FailurePolicy {
  readonly kind: 'player-death';
  /** `mission-start` re-clears the mission; `last-checkpoint` resumes progress. */
  readonly retryFrom: 'mission-start' | 'last-checkpoint';
}

/**
 * When retry progress is banked.
 *
 * `initial` is always the mission start — a retry can never resume *before* the
 * player deployed. `banksOnElimination` decides whether each felled defender is
 * remembered across a death, so a late death does not force re-clearing the ones
 * already down. With `retryFrom: 'mission-start'` this is inert by construction.
 */
export interface CheckpointPolicy {
  readonly initial: 'mission-start';
  readonly banksOnElimination: boolean;
}

/** Optional, purely cosmetic hints for a loading screen / briefing card. */
export interface MissionVisualMetadata {
  readonly palette?: string;
  readonly timeOfDay?: string;
  readonly loadingBlurb?: string;
  /** Accent colour as a packed 0xRRGGBB int, matching the arena palette style. */
  readonly accentColor?: number;
}

/**
 * A single campaign mission. Order-keyed, self-describing, renderer-light.
 */
export interface MissionDefinition {
  /** Branded, validated, unique within a catalog. */
  readonly id: MissionId;
  /** 1-based position; a catalog's orders must be a contiguous 1..N run. */
  readonly order: number;
  readonly title: string;
  /** Short briefing paragraph. */
  readonly brief: string;
  readonly objective: MissionObjective;
  /**
   * The level factory. Returns the exact `ArenaDefinition` the shipping level
   * subsystem consumes. Mission 1 is literally `buildArena`; the others author
   * their own arenas with campaign-owned helpers. Called by the catalog to
   * validate cover/spawns, and later by integration to build the scene.
   */
  readonly createArena: () => ArenaDefinition;
  /** Exactly two floor-based insertion slots. */
  readonly playerSpawns: readonly [SpawnSlot, SpawnSlot];
  /** One or more defenders, each with at least one collidable cover id. */
  readonly enemies: readonly EnemyPlacement[];
  readonly completion: CompletionPolicy;
  readonly failure: FailurePolicy;
  readonly checkpoint: CheckpointPolicy;
  readonly visual?: MissionVisualMetadata;
}
