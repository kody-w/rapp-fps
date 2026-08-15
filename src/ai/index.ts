/**
 * Public surface of the enemy-AI library.
 *
 * The render-facing `AiSystem` lives in `AiSystem.ts` and is imported directly
 * where a `three` scene exists; it is intentionally NOT re-exported here so this
 * entry point stays free of any renderer dependency and can be consumed by the
 * browser-free evidence.
 */

export { EnemyAgent } from './agent.js';
export type { EnemyAgentOptions } from './agent.js';
export { DEFAULT_ENEMY_CONFIG, AI_FIXED_STEP_SECONDS } from './config.js';
export {
  buildArena,
  assertValidStaticWorld,
  lineOfSightClear,
  segmentIntersectsBox,
  boxFromCenter,
  boxCenter,
  ARENA_ENEMY_SPAWN,
  ARENA_ENEMY_YAW,
} from './world.js';
export type { Arena, ArenaCover } from './world.js';
export { canSee } from './perception.js';
export type { SightParams } from './perception.js';
export { rankCover, selectCover } from './cover.js';
export type { CoverCandidate, CoverQuery } from './cover.js';
export { SeededRandom } from './random.js';
export type {
  AgentSnapshot,
  AiState,
  CombatPhase,
  CombatSink,
  DamageEvent,
  EnemyConfig,
  FireShot,
  FootstepStimulus,
  StaticBox,
  StaticWorld,
  StepInput,
  TargetSample,
  Transition,
  TransitionListener,
  TransitionReason,
  Vec3,
} from './types.js';
