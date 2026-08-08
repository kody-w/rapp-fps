import { scoreCoverCandidate } from './cover.js';
import {
  clamp,
  copyVec3,
  distance,
  distanceSquared,
  normalizeHorizontal,
  setVec3,
} from './math.js';
import { SeededRandom } from './random.js';
import type {
  AgentDebugView,
  AgentStorageStats,
  AiState,
  FootstepPayload,
  MutableCoverBuffer,
  MutableCoverCandidate,
  MutablePathBuffer,
  MutableTargetSample,
  MutableVec3,
  ResolvedDamageInput,
  SecurityAgentConfig,
  SecurityAgentPorts,
  TransitionReason,
  Vec3Like,
} from './types.js';

export const AI_FIXED_STEP_SECONDS = 1 / 120;
export const MAX_AI_PATH_POINTS = 16;
export const MAX_AI_COVER_CANDIDATES = 12;

export const DEFAULT_SECURITY_AGENT_CONFIG: Readonly<SecurityAgentConfig> = Object.freeze({
  fixedStepSeconds: AI_FIXED_STEP_SECONDS,
  visionDistance: 24,
  visionHalfAngleRadians: Math.PI * 0.31,
  eyeHeight: 1.65,
  hearingThreshold: 0.16,
  hearingMaxDistance: 28,
  suspiciousSeconds: 0.25,
  investigateSeconds: 1.8,
  reactionDelaySeconds: 0.45,
  lostSightGraceSeconds: 0.35,
  memorySampleSeconds: 0.2,
  memoryErrorMeters: 0.35,
  memoryDecayPerSecond: 0.28,
  engageDecisionSeconds: 1.15,
  suppressSeconds: 0.72,
  repositionSeconds: 0.9,
  searchSeconds: 3.1,
  returnSeconds: 0.9,
  idleSeconds: 0.45,
  burstCooldownMinSeconds: 0.34,
  burstCooldownMaxSeconds: 0.58,
  shotIntervalMinSeconds: 0.085,
  shotIntervalMaxSeconds: 0.125,
  aimErrorRadians: 0.026,
  coverWeights: Object.freeze({
    exposure: 0.55,
    pathCost: 0.25,
    flank: 0.2,
  }),
  coverPathCostNormalization: 18,
  coverTieBreakNoise: 0.075,
});

const NO_TARGET = '';
const MIN_REPOSITION_PATH_POINTS = 2;
const NO_CONFIG_OVERRIDES: Readonly<Partial<SecurityAgentConfig>> = Object.freeze({});

function createStorageStats(): AgentStorageStats {
  return {
    ticks: 0,
    pathCapacity: MAX_AI_PATH_POINTS,
    coverCapacity: MAX_AI_COVER_CANDIDATES,
    maxPathPointsUsed: 0,
    maxCoverCandidatesUsed: 0,
    pathRequests: 0,
    coverQueries: 0,
    ownedSetupObjectAllocations: 1,
    dynamicTickObjectAllocations: 0,
  };
}

function mutableVec3(
  storage: AgentStorageStats,
  x = 0,
  y = 0,
  z = 0,
): MutableVec3 {
  storage.ownedSetupObjectAllocations++;
  return { x, y, z };
}

function createPathBuffer(storage: AgentStorageStats): MutablePathBuffer {
  storage.ownedSetupObjectAllocations++;
  const points: MutableVec3[] = [];
  for (let index = 0; index < MAX_AI_PATH_POINTS; index++) {
    points.push(mutableVec3(storage));
  }
  storage.ownedSetupObjectAllocations++;
  return { points, count: 0 };
}

function createCoverBuffer(storage: AgentStorageStats): MutableCoverBuffer {
  storage.ownedSetupObjectAllocations++;
  const candidates: MutableCoverCandidate[] = [];
  for (let index = 0; index < MAX_AI_COVER_CANDIDATES; index++) {
    const position = mutableVec3(storage);
    storage.ownedSetupObjectAllocations++;
    candidates.push({
      id: '',
      position,
      exposure: 1,
      pathCost: 0,
      flank: 0,
      score: 0,
    });
  }
  storage.ownedSetupObjectAllocations++;
  return { candidates, count: 0 };
}

function createTargetSample(storage: AgentStorageStats): MutableTargetSample {
  const position = mutableVec3(storage);
  const velocity = mutableVec3(storage);
  storage.ownedSetupObjectAllocations++;
  return {
    id: NO_TARGET,
    position,
    velocity,
    alive: false,
  };
}

export class SecurityAgent {
  readonly id: string;

  private readonly ports: SecurityAgentPorts;
  private readonly config: SecurityAgentConfig;
  private readonly random: SeededRandom;
  private readonly storage = createStorageStats();
  private readonly position = mutableVec3(this.storage);
  private readonly forward = mutableVec3(this.storage, 0, 0, 1);
  private readonly eyePosition = mutableVec3(this.storage, 0, 1.65, 0);
  private readonly homePosition = mutableVec3(this.storage);
  private readonly target = createTargetSample(this.storage);
  private readonly lastKnownPosition = mutableVec3(this.storage);
  private readonly interestPosition = mutableVec3(this.storage);
  private readonly searchPosition = mutableVec3(this.storage);
  private readonly path = createPathBuffer(this.storage);
  private readonly cover = createCoverBuffer(this.storage);
  private readonly debug: AgentDebugView;

  private state: AiState = 'patrol';
  private tickIndex = 0;
  private stateEnteredTick = 0;
  private firstVisibleTick = -1;
  private lostSightTicks = 0;
  private nextMemorySampleTick = 0;
  private nextBurstTick = 0;
  private burstId = 0;
  private targetVisible = false;
  private confirmationTargetId = NO_TARGET;
  private hasLastKnownPosition = false;
  private memoryTargetId = NO_TARGET;
  private hasInterestPosition = false;
  private memoryConfidence = 0;
  private selectedCoverIndex = -1;
  private health = 100;
  private maxHealth = 100;

  constructor(
    id: string,
    seed: number,
    ports: SecurityAgentPorts,
    overrides?: Partial<SecurityAgentConfig>,
  ) {
    const configOverrides = overrides ?? NO_CONFIG_OVERRIDES;
    this.id = id;
    this.ports = ports;
    this.storage.ownedSetupObjectAllocations++;
    this.random = new SeededRandom(seed);
    this.storage.ownedSetupObjectAllocations++;
    const coverWeights = {
      ...DEFAULT_SECURITY_AGENT_CONFIG.coverWeights,
      ...configOverrides.coverWeights,
    };
    this.storage.ownedSetupObjectAllocations++;
    this.config = {
      ...DEFAULT_SECURITY_AGENT_CONFIG,
      ...configOverrides,
      coverWeights,
    };
    this.eyePosition.y = this.config.eyeHeight;
    this.storage.ownedSetupObjectAllocations++;
    this.debug = {
      state: this.state,
      tick: 0,
      timeSeconds: 0,
      position: this.position,
      forward: this.forward,
      targetVisible: false,
      targetId: NO_TARGET,
      confirmationTargetId: NO_TARGET,
      targetPosition: this.target.position,
      hasLastKnownPosition: false,
      memoryTargetId: NO_TARGET,
      lastKnownPosition: this.lastKnownPosition,
      memoryConfidence: 0,
      hasInterestPosition: false,
      interestPosition: this.interestPosition,
      path: this.path,
      cover: this.cover,
      selectedCoverIndex: -1,
      health: this.health,
      maxHealth: this.maxHealth,
    };
  }

  setPose(position: Vec3Like, forward: Vec3Like): void {
    copyVec3(this.position, position);
    normalizeHorizontal(this.forward, forward);
    if (this.tickIndex === 0) copyVec3(this.homePosition, position);
  }

  setHome(position: Vec3Like): void {
    copyVec3(this.homePosition, position);
  }

  hearFootstep(payload: FootstepPayload): boolean {
    if (this.state === 'eliminated' || !Number.isFinite(payload.loud)) return false;
    if (
      !Number.isFinite(payload.position.x)
      || !Number.isFinite(payload.position.y)
      || !Number.isFinite(payload.position.z)
    ) return false;

    const range = distance(this.position, payload.position);
    const distanceFactor = clamp(1 - range / this.config.hearingMaxDistance, 0, 1);
    const perceivedLoudness = Math.max(0, payload.loud) * distanceFactor;
    if (perceivedLoudness < this.config.hearingThreshold) return false;

    copyVec3(this.interestPosition, payload.position);
    this.hasInterestPosition = true;
    if (
      this.state === 'idle'
      || this.state === 'patrol'
      || this.state === 'return'
      || this.state === 'search'
    ) {
      this.transition('suspicious', 'footstep-heard');
    }
    return true;
  }

  consumeResolvedDamage(input: ResolvedDamageInput): boolean {
    if (input.id !== this.id || this.state === 'eliminated') return false;
    if (
      !Number.isFinite(input.remainingHealth)
      || !Number.isFinite(input.maxHealth)
      || input.maxHealth <= 0
    ) return false;

    this.maxHealth = input.maxHealth;
    this.health = clamp(input.remainingHealth, 0, input.maxHealth);
    if (input.sourcePosition) {
      copyVec3(this.interestPosition, input.sourcePosition);
      this.hasInterestPosition = true;
      if (this.state === 'idle' || this.state === 'patrol' || this.state === 'return') {
        this.transition('suspicious', 'damage-source');
      }
    }
    if (input.eliminated || this.health <= 0) {
      this.transition('eliminated', 'resolved-damage-eliminated');
    }
    this.syncDebug();
    return true;
  }

  fixedUpdate(stepSeconds = this.config.fixedStepSeconds): void {
    if (
      !Number.isFinite(stepSeconds)
      || Math.abs(stepSeconds - this.config.fixedStepSeconds) > 1e-9
    ) {
      throw new Error(
        `SecurityAgent requires a ${this.config.fixedStepSeconds}s fixed step; received ${stepSeconds}`,
      );
    }
    if (this.state === 'eliminated') {
      this.tickIndex++;
      this.storage.ticks++;
      this.syncDebug();
      return;
    }

    this.tickIndex++;
    this.storage.ticks++;
    this.eyePosition.x = this.position.x;
    this.eyePosition.y = this.position.y + this.config.eyeHeight;
    this.eyePosition.z = this.position.z;

    this.sampleVision();
    this.updateMemory(stepSeconds);
    this.updateBehavior();
    this.syncDebug();
  }

  getDebugView(): Readonly<AgentDebugView> {
    return this.debug;
  }

  getStorageStats(): Readonly<AgentStorageStats> {
    return this.storage;
  }

  /** Every future agent-owned fixed-step allocation must pass through this counter. */
  protected ownDynamicTickObject<T extends object>(value: T): T {
    this.storage.dynamicTickObjectAllocations++;
    return value;
  }

  private get timeSeconds(): number {
    return this.tickIndex * this.config.fixedStepSeconds;
  }

  private secondsToTicks(seconds: number): number {
    return Math.max(0, Math.ceil(seconds / this.config.fixedStepSeconds));
  }

  private stateTicks(): number {
    return this.tickIndex - this.stateEnteredTick;
  }

  private sampleVision(): void {
    const hasTarget = this.ports.perception.sampleTarget(this.id, this.target);
    let visible = false;
    if (hasTarget && this.target.alive) {
      const maxDistanceSquared = this.config.visionDistance * this.config.visionDistance;
      const targetDistanceSquared = distanceSquared(this.eyePosition, this.target.position);
      if (targetDistanceSquared <= maxDistanceSquared) {
        const dx = this.target.position.x - this.eyePosition.x;
        const dz = this.target.position.z - this.eyePosition.z;
        const horizontalDistance = Math.hypot(dx, dz);
        const dot = horizontalDistance <= 1e-9
          ? 1
          : (dx * this.forward.x + dz * this.forward.z) / horizontalDistance;
        if (dot >= Math.cos(this.config.visionHalfAngleRadians)) {
          visible = !this.ports.perception.isOccluded(
            this.eyePosition,
            this.target.position,
            this.target.id,
          );
        }
      }
    }

    this.targetVisible = visible;
    if (visible) {
      const previousTargetId = this.confirmationTargetId;
      const targetChanged = previousTargetId !== this.target.id;
      if (targetChanged) {
        const hadConfirmedIdentity = previousTargetId !== NO_TARGET;
        const wasCombatState = (
          this.state === 'engage'
          || this.state === 'suppress'
          || this.state === 'reposition'
        );
        this.confirmationTargetId = this.target.id;
        this.firstVisibleTick = this.tickIndex;
        this.nextMemorySampleTick = this.tickIndex;
        this.hasLastKnownPosition = false;
        this.memoryTargetId = NO_TARGET;
        this.memoryConfidence = 0;
        if (hadConfirmedIdentity && wasCombatState) {
          this.ports.combat.cease(this.id, 'lost-target', this.timeSeconds);
        }
        if (this.state !== 'suspicious') {
          this.transition(
            'suspicious',
            hadConfirmedIdentity ? 'target-changed' : 'visual-cue',
          );
        }
      } else if (this.firstVisibleTick < 0) {
        this.firstVisibleTick = this.tickIndex;
        if (
          this.state === 'idle'
          || this.state === 'patrol'
          || this.state === 'return'
          || this.state === 'search'
        ) {
          this.transition('suspicious', 'visual-cue');
        }
      }
      this.lostSightTicks = 0;
      if (
        this.tickIndex - this.firstVisibleTick
        >= this.secondsToTicks(this.config.reactionDelaySeconds)
        && this.state !== 'engage'
        && this.state !== 'suppress'
        && this.state !== 'reposition'
      ) {
        this.transition('engage', 'target-confirmed');
      }
      return;
    }

    if (this.firstVisibleTick >= 0) this.firstVisibleTick = -1;
    if (
      this.state === 'engage'
      || this.state === 'suppress'
      || this.state === 'reposition'
    ) {
      this.lostSightTicks++;
    } else {
      this.lostSightTicks = 0;
    }
  }

  private updateMemory(stepSeconds: number): void {
    if (this.targetVisible) {
      if (
        this.memoryTargetId !== this.target.id
        || !this.hasLastKnownPosition
        || this.tickIndex >= this.nextMemorySampleTick
      ) {
        const confidenceBeforeRefresh = this.memoryConfidence;
        const errorScale = this.config.memoryErrorMeters
          * (0.25 + (1 - confidenceBeforeRefresh) * 0.75);
        this.lastKnownPosition.x = this.target.position.x
          + this.random.range(-errorScale, errorScale);
        this.lastKnownPosition.y = this.target.position.y;
        this.lastKnownPosition.z = this.target.position.z
          + this.random.range(-errorScale, errorScale);
        this.hasLastKnownPosition = true;
        this.memoryTargetId = this.target.id;
        this.nextMemorySampleTick = this.tickIndex
          + this.secondsToTicks(this.config.memorySampleSeconds);
      }
      this.memoryConfidence = 1;
      return;
    }

    if (this.hasLastKnownPosition) {
      this.memoryConfidence = Math.max(
        0,
        this.memoryConfidence - this.config.memoryDecayPerSecond * stepSeconds,
      );
      if (this.memoryConfidence === 0) {
        this.hasLastKnownPosition = false;
        this.memoryTargetId = NO_TARGET;
      }
    }
  }

  private updateBehavior(): void {
    if (
      !this.targetVisible
      && (
        this.state === 'engage'
        || this.state === 'suppress'
        || this.state === 'reposition'
      )
      && this.lostSightTicks >= this.secondsToTicks(this.config.lostSightGraceSeconds)
    ) {
      this.transition('search', 'target-occluded');
    }

    switch (this.state) {
      case 'idle':
        if (this.stateTicks() >= this.secondsToTicks(this.config.idleSeconds)) {
          this.transition('patrol', 'idle-complete');
        }
        break;
      case 'patrol':
        break;
      case 'suspicious':
        if (
          !this.targetVisible
          && this.stateTicks() >= this.secondsToTicks(this.config.suspiciousSeconds)
        ) {
          this.transition('investigate', 'suspicion-confirmed');
        }
        break;
      case 'investigate':
        if (
          !this.targetVisible
          && this.stateTicks() >= this.secondsToTicks(this.config.investigateSeconds)
        ) {
          this.transition(
            this.hasInterestPosition || this.hasLastKnownPosition ? 'search' : 'return',
            'investigation-expired',
          );
        }
        break;
      case 'engage':
        if (this.stateTicks() >= this.secondsToTicks(this.config.engageDecisionSeconds)) {
          this.transition('suppress', 'tactical-cycle');
        } else {
          this.updateBurstSchedule();
        }
        break;
      case 'suppress':
        if (this.stateTicks() >= this.secondsToTicks(this.config.suppressSeconds)) {
          if (this.selectCover()) this.transition('reposition', 'cover-selected');
          else this.transition('engage', 'no-cover');
        } else {
          this.updateBurstSchedule();
        }
        break;
      case 'reposition':
        if (this.stateTicks() >= this.secondsToTicks(this.config.repositionSeconds)) {
          this.transition('engage', 'tactical-cycle');
        }
        break;
      case 'search':
        if (!this.hasLastKnownPosition && !this.hasInterestPosition) {
          this.transition('return', 'memory-expired');
        } else if (this.stateTicks() >= this.secondsToTicks(this.config.searchSeconds)) {
          this.transition('return', 'search-expired');
        }
        break;
      case 'return':
        if (this.stateTicks() >= this.secondsToTicks(this.config.returnSeconds)) {
          this.transition('idle', 'returned-home');
        }
        break;
      case 'eliminated':
        break;
    }
  }

  private updateBurstSchedule(): void {
    if (this.targetVisible && this.tickIndex >= this.nextBurstTick) this.scheduleBurst();
  }

  private scheduleBurst(): void {
    const shotCount = 2 + this.random.integer(3);
    const shotInterval = this.random.range(
      this.config.shotIntervalMinSeconds,
      this.config.shotIntervalMaxSeconds,
    );
    const confidencePenalty = 1 + (1 - this.memoryConfidence) * 1.5;
    const yawError = this.random.range(-1, 1)
      * this.config.aimErrorRadians
      * confidencePenalty;
    const pitchError = this.random.range(-0.65, 0.65)
      * this.config.aimErrorRadians
      * confidencePenalty;
    const firstShotAt = this.timeSeconds + 0.05;
    const targetId = this.target.id || 'unknown-target';
    const aimPoint = this.hasLastKnownPosition ? this.lastKnownPosition : this.target.position;

    this.ports.combat.aim(
      this.id,
      targetId,
      aimPoint,
      yawError,
      pitchError,
      this.timeSeconds,
    );
    this.ports.combat.burst(
      this.id,
      targetId,
      aimPoint,
      shotCount,
      shotInterval,
      firstShotAt,
      yawError,
      pitchError,
      ++this.burstId,
    );

    const burstDuration = (shotCount - 1) * shotInterval;
    const cooldown = this.random.range(
      this.config.burstCooldownMinSeconds,
      this.config.burstCooldownMaxSeconds,
    );
    this.nextBurstTick = this.tickIndex
      + this.secondsToTicks(0.05 + burstDuration + cooldown);
  }

  private selectCover(): boolean {
    if (!this.targetVisible && !this.hasLastKnownPosition) return false;
    const targetPoint = this.targetVisible ? this.target.position : this.lastKnownPosition;
    this.cover.count = clamp(
      this.ports.cover.collectCandidates(
        this.id,
        this.position,
        targetPoint,
        this.cover,
      ),
      0,
      MAX_AI_COVER_CANDIDATES,
    );
    this.storage.coverQueries++;
    this.storage.maxCoverCandidatesUsed = Math.max(
      this.storage.maxCoverCandidatesUsed,
      this.cover.count,
    );

    for (let index = 0; index < this.cover.count; index++) {
      const candidate = this.cover.candidates[index];
      const estimatedPathCost = this.ports.navigation.estimatePathCost(
        this.id,
        this.position,
        candidate.position,
      );
      if (!Number.isFinite(estimatedPathCost) || estimatedPathCost < 0) {
        candidate.pathCost = Number.POSITIVE_INFINITY;
        candidate.score = Number.NEGATIVE_INFINITY;
        continue;
      }
      candidate.pathCost = estimatedPathCost;
      const baseScore = scoreCoverCandidate(
        candidate,
        this.config.coverWeights,
        this.config.coverPathCostNormalization,
      );
      candidate.score = baseScore + this.random.range(
        -this.config.coverTieBreakNoise,
        this.config.coverTieBreakNoise,
      );
    }

    this.selectedCoverIndex = -1;
    this.path.count = 0;
    while (true) {
      let bestIndex = -1;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < this.cover.count; index++) {
        const candidate = this.cover.candidates[index];
        if (candidate.score > bestScore) {
          bestScore = candidate.score;
          bestIndex = index;
        }
      }
      if (bestIndex < 0 || !Number.isFinite(bestScore)) {
        this.path.count = 0;
        return false;
      }

      const candidate = this.cover.candidates[bestIndex];
      if (this.requestPath(candidate.position) >= MIN_REPOSITION_PATH_POINTS) {
        this.selectedCoverIndex = bestIndex;
        return true;
      }
      candidate.score = Number.NEGATIVE_INFINITY;
    }
  }

  private requestPath(destination: Vec3Like): number {
    const requestedCount = this.ports.navigation.requestPath(
      this.id,
      this.position,
      destination,
      this.path,
    );
    this.path.count = Number.isFinite(requestedCount)
      ? clamp(Math.floor(requestedCount), 0, MAX_AI_PATH_POINTS)
      : 0;
    this.storage.pathRequests++;
    this.storage.maxPathPointsUsed = Math.max(
      this.storage.maxPathPointsUsed,
      this.path.count,
    );
    return this.path.count;
  }

  private transition(next: AiState, reason: TransitionReason): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    this.stateEnteredTick = this.tickIndex;
    this.ports.observer?.transition(
      this.id,
      previous,
      next,
      reason,
      this.tickIndex,
      this.timeSeconds,
    );

    switch (next) {
      case 'idle':
        this.path.count = 0;
        break;
      case 'patrol':
        this.hasInterestPosition = false;
        this.hasLastKnownPosition = false;
        this.memoryTargetId = NO_TARGET;
        this.memoryConfidence = 0;
        this.selectedCoverIndex = -1;
        this.cover.count = 0;
        this.path.count = 0;
        break;
      case 'suspicious':
        break;
      case 'investigate':
        if (this.hasInterestPosition) this.requestPath(this.interestPosition);
        else if (this.hasLastKnownPosition) this.requestPath(this.lastKnownPosition);
        break;
      case 'engage':
        this.nextBurstTick = this.tickIndex;
        if (this.targetVisible) this.scheduleBurst();
        break;
      case 'suppress': {
        const targetId = this.target.id || 'unknown-target';
        const aimPoint = this.hasLastKnownPosition
          ? this.lastKnownPosition
          : this.target.position;
        this.ports.combat.suppress(
          this.id,
          targetId,
          aimPoint,
          this.config.suppressSeconds,
          this.timeSeconds,
        );
        this.nextBurstTick = this.tickIndex;
        if (this.targetVisible) this.scheduleBurst();
        break;
      }
      case 'reposition': {
        const candidate = this.cover.candidates[this.selectedCoverIndex];
        this.ports.combat.reposition(
          this.id,
          candidate.id,
          candidate.position,
          candidate.score,
          this.timeSeconds,
        );
        break;
      }
      case 'search': {
        const center = this.hasLastKnownPosition
          ? this.lastKnownPosition
          : this.interestPosition;
        const radius = 1.1 + (1 - this.memoryConfidence) * 2.4;
        setVec3(
          this.searchPosition,
          center.x + this.random.range(-radius, radius),
          center.y,
          center.z + this.random.range(-radius, radius),
        );
        copyVec3(this.interestPosition, this.searchPosition);
        this.hasInterestPosition = true;
        this.requestPath(this.searchPosition);
        if (
          previous === 'engage'
          || previous === 'suppress'
          || previous === 'reposition'
        ) {
          this.ports.combat.cease(this.id, 'lost-target', this.timeSeconds);
        }
        break;
      }
      case 'return':
        this.hasInterestPosition = false;
        this.hasLastKnownPosition = false;
        this.memoryTargetId = NO_TARGET;
        this.memoryConfidence = 0;
        this.requestPath(this.homePosition);
        break;
      case 'eliminated':
        this.path.count = 0;
        this.cover.count = 0;
        this.targetVisible = false;
        this.confirmationTargetId = NO_TARGET;
        this.memoryTargetId = NO_TARGET;
        this.ports.combat.cease(this.id, 'eliminated', this.timeSeconds);
        break;
    }
    this.syncDebug();
  }

  private syncDebug(): void {
    this.debug.state = this.state;
    this.debug.tick = this.tickIndex;
    this.debug.timeSeconds = this.timeSeconds;
    this.debug.targetVisible = this.targetVisible;
    this.debug.targetId = this.target.id;
    this.debug.confirmationTargetId = this.confirmationTargetId;
    this.debug.hasLastKnownPosition = this.hasLastKnownPosition;
    this.debug.memoryTargetId = this.memoryTargetId;
    this.debug.memoryConfidence = this.memoryConfidence;
    this.debug.hasInterestPosition = this.hasInterestPosition;
    this.debug.selectedCoverIndex = this.selectedCoverIndex;
    this.debug.health = this.health;
    this.debug.maxHealth = this.maxHealth;
  }
}
