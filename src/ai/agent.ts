/**
 * The enemy. One type, one deterministic 120 Hz state machine.
 *
 * States: patrol · investigate · engage · reposition · search · dead.
 * Every edge below is reachable, and the reachability fixture drives inputs to
 * fire each one and records which fired. There is deliberately no
 * `memory-expired` edge: in PR #24 that edge's guard (`no interest AND no
 * last-known`) was contradicted by `search`'s own entry, which always set
 * interest, so it could never fire while a test claimed it did. Here, "memory
 * ran out" is simply the `search` timeout (`abandoned`), which is genuinely
 * reachable.
 *
 * The machine is a pure function of (seed, config, per-step inputs). It reads no
 * wall clock and no render dt; it advances only when `fixedStep` is called. That
 * is what makes its behaviour identical at 30 and 240 fps and reproducible from
 * a seed. All randomness comes from one `SeededRandom`.
 *
 *   transition           edge                                   reason
 *   ───────────────────  ─────────────────────────────────────  ─────────────
 *   heard                patrol       → investigate              a footstep in range, not yet seen
 *   spotted              patrol       → engage                   seen ≥ reaction delay
 *   confirmed            investigate  → engage                   seen ≥ reaction delay
 *   lost-interest        investigate  → patrol                   investigate timer, never confirmed
 *   repositioning        engage       → reposition               dwell / damage, another cover exists
 *   in-position          reposition   → engage                   reached the new cover
 *   lost-sight           engage       → search                   no LOS ≥ grace
 *   lost-sight           reposition   → search                   no LOS ≥ grace while moving
 *   reacquired           search       → engage                   seen ≥ reaction delay
 *   abandoned            search       → patrol                   search timer, never reacquired
 *   killed               (any live)   → dead                     health ≤ 0
 */

import type {
  AgentSnapshot,
  AiState,
  CombatPhase,
  CombatSink,
  EnemyConfig,
  FireShot,
  StaticWorld,
  StepInput,
  TargetSample,
  Transition,
  TransitionListener,
  TransitionReason,
  Vec3,
} from './types.js';
import type { ArenaCover } from './world.js';
import { SeededRandom } from './random.js';
import { canSee } from './perception.js';
import { selectCover } from './cover.js';
import {
  clamp,
  copy,
  distanceXZ,
  normalize,
  set,
  turnToward,
  v3,
} from './math.js';

export interface EnemyAgentOptions {
  spawn?: Vec3;
  /** Initial facing, radians. yaw 0 faces −Z (into the scene). */
  yaw?: number;
  /** Optional patrol loop; fewer than two points means stand and scan. */
  patrol?: Vec3[];
  combat?: CombatSink;
  onTransition?: TransitionListener;
}

const MAX_TRANSITION_LOG = 512;
const MAX_FIRE_LOG = 256;
const AGENT_RADIUS = 0.34;

/** yaw → unit forward on the ground plane; yaw 0 faces −Z. */
function yawToForward(out: Vec3, yaw: number): Vec3 {
  out.x = Math.sin(yaw);
  out.y = 0;
  out.z = -Math.cos(yaw);
  return out;
}

/** Heading that points from `from` toward `to` on the ground plane. */
function headingTo(from: Vec3, to: Vec3): number {
  return Math.atan2(to.x - from.x, -(to.z - from.z));
}

export class EnemyAgent {
  readonly config: EnemyConfig;
  private readonly world: StaticWorld;
  private readonly cover: readonly ArenaCover[];
  private readonly halfExtent: number;
  private readonly rng: SeededRandom;
  private readonly combat: CombatSink | undefined;
  private readonly onTransition: TransitionListener | undefined;

  // ── Kinematics ────────────────────────────────────────────────────────
  readonly position: Vec3 = v3();
  yaw = 0;
  readonly forward: Vec3 = v3(0, 0, -1);
  private desiredYaw = 0;
  private readonly moveGoal: Vec3 = v3();
  private hasMoveGoal = false;

  // ── Bookkeeping ───────────────────────────────────────────────────────
  state: AiState = 'patrol';
  tick = 0;
  time = 0;
  health: number;
  private stateSeconds = 0;
  readonly transitions: Transition[] = [];
  readonly fireLog: FireShot[] = [];

  // ── Perception ────────────────────────────────────────────────────────
  canSeeNow = false;
  confirmed = false;
  private visibleSeconds = 0;
  private sightLostSeconds = 0;
  hasLastKnown = false;
  readonly lastKnown: Vec3 = v3();
  targetId = '';

  // ── Interest (hearing) ────────────────────────────────────────────────
  hasInterest = false;
  readonly interest: Vec3 = v3();
  private heardStimulus = false;

  // ── Cover / repositioning ─────────────────────────────────────────────
  selectedCoverId = '';
  private selectedCoverBoxId = '';
  private readonly coverGoal: Vec3 = v3();
  private hasCoverGoal = false;
  private readonly repoGoal: Vec3 = v3();
  private dwellSeconds = 0;
  private wantsReposition = false;
  private damageTimer = 0;

  // ── Firing ────────────────────────────────────────────────────────────
  combatPhase: CombatPhase = 'idle';
  private phaseSeconds = 0;
  private burstShotsFired = 0;
  shotsFired = 0;
  bursts = 0;
  private readonly aimPoint: Vec3 = v3();

  // ── Patrol / search scan ──────────────────────────────────────────────
  private readonly patrol: Vec3[];
  private patrolIndex = 0;
  private scanPhase = 0;
  private patrolBaseYaw = 0;
  private readonly searchAnchor: Vec3 = v3();
  private readonly searchGoal: Vec3 = v3();
  private hasSearchGoal = false;

  // ── Death ─────────────────────────────────────────────────────────────
  deathSeconds = 0;

  // Scratch — reused every tick so the hot path allocates nothing.
  private readonly _eye: Vec3 = v3();
  private readonly _tp: Vec3 = v3();
  private readonly _dir: Vec3 = v3();
  private readonly _right: Vec3 = v3();
  private readonly _up: Vec3 = v3();

  constructor(
    config: EnemyConfig,
    world: StaticWorld,
    cover: readonly ArenaCover[],
    halfExtent: number,
    options: EnemyAgentOptions = {},
  ) {
    this.config = config;
    this.world = world;
    this.cover = cover;
    this.halfExtent = halfExtent;
    this.rng = new SeededRandom(config.seed);
    this.combat = options.combat;
    this.onTransition = options.onTransition;
    this.health = config.maxHealth;
    this.patrol = options.patrol ? options.patrol.map((p) => v3(p.x, p.y, p.z)) : [];

    if (options.spawn) copy(this.position, options.spawn);
    this.yaw = options.yaw ?? 0;
    this.desiredYaw = this.yaw;
    this.patrolBaseYaw = this.yaw;
    yawToForward(this.forward, this.yaw);
  }

  /** Advance one fixed step. `step` should equal `config.fixedStepSeconds`. */
  fixedStep(step: number, input: StepInput): void {
    this.tick++;
    this.time += step;

    if (this.state === 'dead') {
      this.deathSeconds += step;
      return;
    }

    // 1. Damage, then the single death guard reachable from any live state.
    if (input.damage) {
      for (const d of input.damage) {
        this.health -= d.amount;
        this.damageTimer = this.config.damageMemorySeconds;
        this.wantsReposition = true;
      }
    }
    if (this.health <= 0) {
      this.enterDead();
      return;
    }
    this.damageTimer = Math.max(0, this.damageTimer - step);

    // 2. Perception and hearing.
    this.perceive(step, input.target);
    this.heardStimulus = false;
    this.ingestFootsteps(input);

    // 3. State behaviour and transitions.
    this.stateSeconds += step;
    this.updateState(step);

    // 4. Turn, then move, then refresh forward for next tick's perception.
    this.yaw = turnToward(this.yaw, this.desiredYaw, this.config.turnSpeedRadians * step);
    this.integrateMovement(step);
    yawToForward(this.forward, this.yaw);
  }

  // ── Perception ─────────────────────────────────────────────────────────

  private perceive(step: number, target: TargetSample): void {
    const c = this.config;
    set(this._eye, this.position.x, this.position.y + c.eyeHeight, this.position.z);
    set(this._tp, target.position.x, target.position.y + c.targetSampleHeight, target.position.z);

    const see = target.alive && canSee(this._eye, this.forward, this._tp, this.world, {
      visionDistance: c.visionDistance,
      visionHalfAngleRadians: c.visionHalfAngleRadians,
    });

    this.canSeeNow = see;
    if (see) {
      this.visibleSeconds += step;
      this.sightLostSeconds = 0;
      copy(this.lastKnown, target.position);
      this.hasLastKnown = true;
      this.targetId = target.id;
    } else {
      this.visibleSeconds = 0;
      this.sightLostSeconds += step;
    }
    this.confirmed = see && this.visibleSeconds >= c.reactionDelaySeconds;
  }

  private ingestFootsteps(input: StepInput): void {
    if (!input.footsteps || input.footsteps.length === 0) return;
    // Only patrol and investigate act on hearing; once engaged or searching the
    // enemy already has a stronger track than a footstep would provide.
    if (this.state !== 'patrol' && this.state !== 'investigate') return;
    for (const f of input.footsteps) {
      const radius = this.config.hearingRadius * clamp(f.loud, 0, 1);
      if (distanceXZ(this.position, f.position) <= radius) {
        copy(this.interest, f.position);
        this.hasInterest = true;
        if (this.state === 'patrol') this.heardStimulus = true;
      }
    }
  }

  // ── State machine ──────────────────────────────────────────────────────

  private updateState(step: number): void {
    switch (this.state) {
      case 'patrol':
        this.patrolBehavior(step);
        if (this.confirmed) { this.enterEngage('spotted'); return; }
        if (this.heardStimulus) { this.enterInvestigate(); return; }
        return;

      case 'investigate':
        this.faceAndSeek(this.interest);
        if (this.confirmed) { this.enterEngage('confirmed'); return; }
        if (this.stateSeconds >= this.config.investigateSeconds) {
          this.enterPatrol('lost-interest');
        }
        return;

      case 'engage':
        this.engageBehavior(step);
        if (this.sightLostSeconds >= this.config.lostSightGraceSeconds) {
          this.enterSearch('lost-sight');
          return;
        }
        if (this.shouldReposition() && this.tryReposition('repositioning')) return;
        return;

      case 'reposition':
        this.repositionBehavior();
        if (this.sightLostSeconds >= this.config.lostSightGraceSeconds) {
          this.enterSearch('lost-sight');
          return;
        }
        if (
          distanceXZ(this.position, this.repoGoal) <= this.config.arrivalRadius ||
          this.stateSeconds >= this.config.repositionMaxSeconds
        ) {
          this.enterEngage('in-position', true);
        }
        return;

      case 'search':
        this.searchBehavior();
        if (this.confirmed) { this.enterEngage('reacquired'); return; }
        if (this.stateSeconds >= this.config.searchSeconds) {
          this.enterPatrol('abandoned');
        }
        return;

      case 'dead':
        return;
    }
  }

  private transition(to: AiState, reason: TransitionReason): void {
    const t: Transition = { from: this.state, to, reason, tick: this.tick, time: this.time };
    this.state = to;
    this.stateSeconds = 0;
    this.transitions.push(t);
    if (this.transitions.length > MAX_TRANSITION_LOG) this.transitions.shift();
    this.onTransition?.(t);
  }

  // ── State entries ──────────────────────────────────────────────────────

  private enterPatrol(reason: TransitionReason): void {
    this.hasInterest = false;
    this.hasMoveGoal = this.patrol.length >= 2;
    this.scanPhase = 0;
    this.patrolBaseYaw = this.yaw;
    this.resetCombat('reposition');
    this.transition('patrol', reason);
  }

  private enterInvestigate(): void {
    this.hasMoveGoal = true;
    this.transition('investigate', 'heard');
  }

  private enterEngage(reason: TransitionReason, keepCover = false): void {
    if (keepCover) {
      copy(this.coverGoal, this.repoGoal);
      this.hasCoverGoal = true;
    } else {
      // Initial contact must produce a readable fight before movement. Cover
      // selection belongs to tryReposition() after the measured dwell/damage
      // trigger; moving to zero-exposure cover here made the enemy lose sight
      // before its first telegraph and fire no rounds.
      this.hasCoverGoal = false;
      this.selectedCoverId = '';
      this.selectedCoverBoxId = '';
    }
    this.dwellSeconds = 0;
    this.wantsReposition = false;
    this.combatPhase = 'acquire';
    this.phaseSeconds = 0;
    this.burstShotsFired = 0;
    this.transition('engage', reason);
  }

  private tryReposition(reason: TransitionReason): boolean {
    const cover = selectCover({
      world: this.world,
      cover: this.cover,
      agent: this.position,
      threat: this.lastKnown,
      config: this.config,
      rng: this.rng,
      excludeBoxId: this.selectedCoverBoxId || undefined,
      halfExtent: this.halfExtent,
    });
    if (!cover) return false; // no better stance: stay and keep fighting
    copy(this.repoGoal, cover.position);
    this.selectedCoverId = cover.id;
    this.selectedCoverBoxId = cover.boxId;
    this.hasMoveGoal = true;
    this.resetCombat('reposition');
    this.transition('reposition', reason);
    return true;
  }

  private enterSearch(reason: TransitionReason): void {
    copy(this.searchAnchor, this.lastKnown);
    this.hasSearchGoal = false;
    this.hasMoveGoal = true;
    this.resetCombat('lost-target');
    this.transition('search', reason);
  }

  private enterDead(): void {
    this.resetCombat('killed');
    this.deathSeconds = 0;
    this.hasMoveGoal = false;
    this.transition('dead', 'killed');
  }

  private resetCombat(cease: 'lost-target' | 'reposition' | 'killed'): void {
    if (this.combatPhase === 'telegraph' || this.combatPhase === 'burst') {
      this.combat?.onCease?.(cease, this.time);
    }
    this.combatPhase = 'idle';
    this.phaseSeconds = 0;
    this.burstShotsFired = 0;
  }

  // ── Behaviours ─────────────────────────────────────────────────────────

  private patrolBehavior(step: number): void {
    if (this.patrol.length >= 2) {
      const goal = this.patrol[this.patrolIndex];
      copy(this.moveGoal, goal);
      this.hasMoveGoal = true;
      if (distanceXZ(this.position, goal) <= this.config.arrivalRadius) {
        this.patrolIndex = (this.patrolIndex + 1) % this.patrol.length;
      }
      this.desiredYaw = headingTo(this.position, goal);
    } else {
      // Stand and sweep the cone so a stationary guard still reads as watching.
      this.hasMoveGoal = false;
      this.scanPhase += step * 0.9;
      const amp = this.config.visionHalfAngleRadians * 0.7;
      this.desiredYaw = this.patrolBaseYaw + Math.sin(this.scanPhase) * amp;
    }
  }

  private faceAndSeek(goal: Vec3): void {
    copy(this.moveGoal, goal);
    this.hasMoveGoal = true;
    this.desiredYaw = headingTo(this.position, goal);
  }

  private engageBehavior(step: number): void {
    this.dwellSeconds += step;
    this.desiredYaw = headingTo(this.position, this.lastKnown);
    if (this.hasCoverGoal) {
      copy(this.moveGoal, this.coverGoal);
      this.hasMoveGoal = true;
    } else {
      this.hasMoveGoal = false;
    }
    this.runCombat(step);
  }

  private repositionBehavior(): void {
    copy(this.moveGoal, this.repoGoal);
    this.hasMoveGoal = true;
    // Keep tracking the threat while moving; a repositioning enemy still faces
    // where it expects the player to be, not the direction it walks.
    this.desiredYaw = headingTo(this.position, this.lastKnown);
  }

  private searchBehavior(): void {
    if (!this.hasSearchGoal || distanceXZ(this.position, this.searchGoal) <= this.config.arrivalRadius) {
      const r = this.config.searchRadius;
      const gx = clamp(this.searchAnchor.x + this.rng.range(-r, r), -this.halfExtent, this.halfExtent);
      const gz = clamp(this.searchAnchor.z + this.rng.range(-r, r), -this.halfExtent, this.halfExtent);
      set(this.searchGoal, gx, 0, gz);
      this.hasSearchGoal = true;
    }
    copy(this.moveGoal, this.searchGoal);
    this.hasMoveGoal = true;
    this.desiredYaw = headingTo(this.position, this.searchGoal);
  }

  private shouldReposition(): boolean {
    return this.wantsReposition || this.dwellSeconds >= this.config.repositionDwellSeconds;
  }

  // ── Firing telegraph cycle (only within engage) ─────────────────────────

  private runCombat(step: number): void {
    const c = this.config;
    switch (this.combatPhase) {
      case 'idle':
        this.combatPhase = 'acquire';
        this.phaseSeconds = 0;
        return;

      case 'acquire':
        this.phaseSeconds += step;
        if (this.canSeeNow) this.combat?.onAim?.(this.lastKnown, this.time);
        if (this.canSeeNow && this.phaseSeconds >= c.acquireSeconds) this.startTelegraph();
        return;

      case 'telegraph':
        this.phaseSeconds += step;
        if (!this.canSeeNow) {
          // Lost the shot during the wind-up: never fire blind.
          this.resetCombat('lost-target');
          this.combatPhase = 'cooldown';
          this.phaseSeconds = 0;
          return;
        }
        if (this.phaseSeconds >= c.telegraphSeconds) {
          this.combatPhase = 'burst';
          this.phaseSeconds = 0;
          this.burstShotsFired = 0;
        }
        return;

      case 'burst': {
        this.phaseSeconds += step;
        while (
          this.burstShotsFired < c.burstCount &&
          this.phaseSeconds >= this.burstShotsFired * c.shotIntervalSeconds
        ) {
          if (!this.canSeeNow) break;
          this.fireShot(this.burstShotsFired);
          this.burstShotsFired++;
        }
        if (!this.canSeeNow) {
          this.combat?.onCease?.('lost-target', this.time);
          this.combatPhase = 'cooldown';
          this.phaseSeconds = 0;
        } else if (this.burstShotsFired >= c.burstCount) {
          this.bursts++;
          this.combatPhase = 'cooldown';
          this.phaseSeconds = 0;
        }
        return;
      }

      case 'cooldown':
        this.phaseSeconds += step;
        if (this.phaseSeconds >= c.cooldownSeconds) {
          this.combatPhase = 'acquire';
          this.phaseSeconds = 0;
        }
        return;
    }
  }

  private startTelegraph(): void {
    // Commit the aim at the start of the wind-up so that moving after the
    // telegraph lets the player slip the shot — the reason it is telegraphed.
    set(
      this.aimPoint,
      this.lastKnown.x,
      this.lastKnown.y + this.config.targetSampleHeight,
      this.lastKnown.z,
    );
    this.combatPhase = 'telegraph';
    this.phaseSeconds = 0;
    this.combat?.onTelegraph?.(this.aimPoint, this.config.telegraphSeconds, this.time);
  }

  private fireShot(index: number): void {
    const c = this.config;
    set(this._eye, this.position.x, this.position.y + c.eyeHeight, this.position.z);
    normalize(this._dir, {
      x: this.aimPoint.x - this._eye.x,
      y: this.aimPoint.y - this._eye.y,
      z: this.aimPoint.z - this._eye.z,
    });

    // Build a stable basis around the aim direction, then rotate by seeded
    // yaw/pitch error so the shot scatters like a person, not a laser.
    const yawErr = this.rng.gaussian() * c.aimErrorRadians;
    const pitchErr = this.rng.gaussian() * c.aimErrorRadians;
    // right = normalize(dir × worldUp); up = right × dir
    set(this._right, this._dir.z, 0, -this._dir.x);
    normalize(this._right, this._right);
    set(
      this._up,
      this._right.y * this._dir.z - this._right.z * this._dir.y,
      this._right.z * this._dir.x - this._right.x * this._dir.z,
      this._right.x * this._dir.y - this._right.y * this._dir.x,
    );
    const ty = Math.tan(yawErr);
    const tp = Math.tan(pitchErr);
    const dx = this._dir.x + this._right.x * ty + this._up.x * tp;
    const dy = this._dir.y + this._right.y * ty + this._up.y * tp;
    const dz = this._dir.z + this._right.z * ty + this._up.z * tp;
    const dir = v3(dx, dy, dz);
    normalize(dir, dir);

    const shot: FireShot = {
      targetId: this.targetId || undefined,
      origin: v3(this._eye.x, this._eye.y, this._eye.z),
      direction: dir,
      aimError: Math.hypot(yawErr, pitchErr),
      burstIndex: index,
      time: this.time,
    };
    this.shotsFired++;
    this.fireLog.push(shot);
    if (this.fireLog.length > MAX_FIRE_LOG) this.fireLog.shift();
    this.combat?.onFire?.(shot);
  }

  // ── Movement ───────────────────────────────────────────────────────────

  private integrateMovement(step: number): void {
    if (!this.hasMoveGoal) return;
    const dx = this.moveGoal.x - this.position.x;
    const dz = this.moveGoal.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-4) {
      const m = Math.min(this.config.moveSpeed * step, dist);
      this.position.x += (dx / dist) * m;
      this.position.z += (dz / dist) * m;
    }
    this.separateFromBoxes();
  }

  /**
   * Cheap circle-vs-AABB push-out so the body never ends up inside a cover box.
   * Goals are generated outside boxes, so this only nudges the short transits.
   */
  private separateFromBoxes(): void {
    for (const box of this.world.boxes) {
      const minX = box.min.x - AGENT_RADIUS;
      const maxX = box.max.x + AGENT_RADIUS;
      const minZ = box.min.z - AGENT_RADIUS;
      const maxZ = box.max.z + AGENT_RADIUS;
      const p = this.position;
      if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;
      // Inside the inflated footprint: eject along the least-penetration axis.
      const penL = p.x - minX;
      const penR = maxX - p.x;
      const penD = p.z - minZ;
      const penU = maxZ - p.z;
      const minPen = Math.min(penL, penR, penD, penU);
      if (minPen === penL) p.x = minX;
      else if (minPen === penR) p.x = maxX;
      else if (minPen === penD) p.z = minZ;
      else p.z = maxZ;
    }
  }

  // ── Read-out ───────────────────────────────────────────────────────────

  /** Fraction of the current telegraph elapsed, 0..1, for a wind-up indicator. */
  telegraphProgress(): number {
    if (this.combatPhase !== 'telegraph') return 0;
    return clamp(this.phaseSeconds / this.config.telegraphSeconds, 0, 1);
  }

  snapshot(): AgentSnapshot {
    return {
      state: this.state,
      tick: this.tick,
      time: round(this.time),
      health: round(this.health),
      position: roundV(this.position),
      yaw: round(this.yaw),
      forward: roundV(this.forward),
      canSeeNow: this.canSeeNow,
      confirmed: this.confirmed,
      visibleSeconds: round(this.visibleSeconds),
      sightLostSeconds: round(this.sightLostSeconds),
      hasLastKnown: this.hasLastKnown,
      lastKnown: roundV(this.lastKnown),
      targetId: this.targetId,
      hasInterest: this.hasInterest,
      interest: roundV(this.interest),
      moveGoal: roundV(this.moveGoal),
      hasMoveGoal: this.hasMoveGoal,
      selectedCoverId: this.selectedCoverId,
      combatPhase: this.combatPhase,
      phaseSeconds: round(this.phaseSeconds),
      shotsFired: this.shotsFired,
      bursts: this.bursts,
    };
  }
}

// Snapshots are compared for determinism; round to kill float noise below the
// resolution any behaviour depends on, so equality is exact and meaningful.
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function roundV(v: Vec3): Vec3 {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}
