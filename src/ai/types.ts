/**
 * Shared types for the enemy-AI core.
 *
 * Kept deliberately free of any `three` import: the whole simulation is plain
 * numbers so it can run in a browser-free Node fixture and be diffed for
 * determinism. The render-facing `AiSystem` adapts these to `THREE.Vector3`;
 * nothing here knows the renderer exists.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned box, min/max corners in world space. */
export interface StaticBox {
  id: string;
  min: Vec3;
  max: Vec3;
}

/**
 * The occluding world the enemy reasons about.
 *
 * Named to mirror the axis-aligned `StaticWorld` the AI mandate expected in
 * `src/core/collision.ts`. That module does not exist on `main`; rather than
 * edit core, this library owns an equivalent so line-of-sight and cover resolve
 * against the same boxes that are rendered. If core later ships a canonical
 * collision world, this is the seam to delete.
 */
export interface StaticWorld {
  boxes: StaticBox[];
}

/** Every state the enemy can be in. `dead` is terminal. */
export type AiState =
  | 'patrol'
  | 'investigate'
  | 'engage'
  | 'reposition'
  | 'search'
  | 'dead';

/**
 * The reason attached to a transition. Each maps to exactly one edge in the
 * machine, so the reachability fixture can assert "transition X fired" by name
 * rather than by inferring it from state pairs.
 *
 * There is intentionally no `memory-expired`: that was the unreachable edge in
 * PR #24 (entering `search` always set interest, so its guard could never be
 * true). Memory running out is expressed as the `search` timeout, `abandoned`.
 */
export type TransitionReason =
  | 'heard' //          patrol      -> investigate
  | 'spotted' //        patrol      -> engage
  | 'confirmed' //      investigate -> engage
  | 'lost-interest' //  investigate -> patrol
  | 'repositioning' //  engage      -> reposition
  | 'in-position' //    reposition  -> engage
  | 'lost-sight' //     engage      -> search  |  reposition -> search
  | 'reacquired' //     search      -> engage
  | 'abandoned' //      search      -> patrol
  | 'killed'; //        (any live)  -> dead

export interface Transition {
  from: AiState;
  to: AiState;
  reason: TransitionReason;
  /** Fixed-step index on which the edge fired. */
  tick: number;
  /** Simulated seconds at the moment it fired. */
  time: number;
}

/** Authoritative sample of the player, supplied by the host once per tick. */
export interface TargetSample {
  id: string;
  position: Vec3;
  alive: boolean;
}

/** A footstep the enemy may hear. `loud` in [0, 1] scales the hearing radius. */
export interface FootstepStimulus {
  position: Vec3;
  loud: number;
}

/** Damage applied to the enemy this tick, resolved by the host, not by AI. */
export interface DamageEvent {
  amount: number;
  sourcePosition?: Vec3;
}

/** Everything the enemy is told about the world for one fixed step. */
export interface StepInput {
  target: TargetSample;
  footsteps?: readonly FootstepStimulus[];
  damage?: readonly DamageEvent[];
}

/** One discharged shot the host may turn into ballistics; AI resolves no hits. */
export interface FireShot {
  origin: Vec3;
  direction: Vec3;
  /** Angular scatter applied to this shot, radians, for evidence. */
  aimError: number;
  /** 0-based index within the current burst. */
  burstIndex: number;
  time: number;
}

/**
 * Combat output. These are requests — aim here, the wind-up started, a shot
 * left the muzzle — never authoritative damage. The host decides what a shot
 * hits. Positions are copied out, never aliased to agent scratch.
 */
export interface CombatSink {
  /** The reticle is tracking `aim` (world point). */
  onAim?(aim: Vec3, time: number): void;
  /** A telegraph (readable wind-up) began; it will resolve in `windup` s. */
  onTelegraph?(aim: Vec3, windup: number, time: number): void;
  /** A round was fired. */
  onFire?(shot: FireShot): void;
  /** Firing stopped for a reason the player can read. */
  onCease?(reason: 'lost-target' | 'reposition' | 'killed', time: number): void;
}

export type TransitionListener = (t: Transition) => void;

/** Internal firing sub-phase within `engage`, surfaced for evidence only. */
export type CombatPhase = 'idle' | 'acquire' | 'telegraph' | 'burst' | 'cooldown';

export interface EnemyConfig {
  /** Seed for every stochastic decision. */
  seed: number;
  /** Simulation step, seconds. The engine's fixed step is 1/120. */
  fixedStepSeconds: number;

  // ── Perception ──────────────────────────────────────────────────────────
  /** Maximum sight range, metres. */
  visionDistance: number;
  /** Half the field-of-view cone, radians. */
  visionHalfAngleRadians: number;
  /** Eye height above the enemy's ground position, metres. */
  eyeHeight: number;
  /** Height on the target the sight ray aims at (torso/head), metres. */
  targetSampleHeight: number;
  /** Continuous visible time before the enemy reacts, seconds. */
  reactionDelaySeconds: number;
  /** How long lost line-of-sight is tolerated before giving up contact. */
  lostSightGraceSeconds: number;
  /** Base hearing radius at full loudness, metres. */
  hearingRadius: number;

  // ── Timers ──────────────────────────────────────────────────────────────
  investigateSeconds: number;
  searchSeconds: number;
  /** Radius the enemy wanders around the last-known point while searching. */
  searchRadius: number;

  // ── Movement ────────────────────────────────────────────────────────────
  moveSpeed: number;
  turnSpeedRadians: number;
  /** Distance at which a move goal counts as reached, metres. */
  arrivalRadius: number;

  // ── Cover / repositioning ───────────────────────────────────────────────
  /** Dwell in cover before repositioning on principle, seconds. */
  repositionDwellSeconds: number;
  /** Hard cap on a reposition move before committing to engage, seconds. */
  repositionMaxSeconds: number;
  /** How long taking damage keeps "I should move" true, seconds. */
  damageMemorySeconds: number;
  /** Stand-off from a cover box's face, metres. */
  coverStandOff: number;
  /** Head height used when testing whether a cover stance is exposed, metres. */
  coverStanceHeight: number;
  /** Reject cover candidates closer than this to the threat, metres. */
  coverMinThreatSeparation: number;
  coverWeightExposure: number;
  coverWeightPath: number;
  coverWeightFlank: number;
  /** Path-cost normaliser so distance and exposure are comparable. */
  coverPathNormalize: number;

  // ── Firing telegraph ────────────────────────────────────────────────────
  /** Delay after acquiring before the wind-up starts, seconds. */
  acquireSeconds: number;
  /** Readable wind-up before the first shot, seconds. */
  telegraphSeconds: number;
  /** Rounds per burst. */
  burstCount: number;
  /** Seconds between rounds in a burst. */
  shotIntervalSeconds: number;
  /** Rest after a burst before the next acquire, seconds. */
  cooldownSeconds: number;
  /** 1σ aim scatter, radians. Larger = more beatable. */
  aimErrorRadians: number;

  // ── Health ──────────────────────────────────────────────────────────────
  maxHealth: number;
  /** Ragdoll/settle time after death before the body is inert, seconds. */
  deathSettleSeconds: number;
}

/** A flat, diffable snapshot of the enemy — the unit of determinism evidence. */
export interface AgentSnapshot {
  state: AiState;
  tick: number;
  time: number;
  health: number;
  position: Vec3;
  yaw: number;
  forward: Vec3;
  canSeeNow: boolean;
  confirmed: boolean;
  visibleSeconds: number;
  sightLostSeconds: number;
  hasLastKnown: boolean;
  lastKnown: Vec3;
  targetId: string;
  hasInterest: boolean;
  interest: Vec3;
  moveGoal: Vec3;
  hasMoveGoal: boolean;
  selectedCoverId: string;
  combatPhase: CombatPhase;
  phaseSeconds: number;
  shotsFired: number;
  bursts: number;
}
