import type { SurfaceKind } from '../core/contracts.js';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface MutableVec3 extends Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type AiState =
  | 'idle'
  | 'patrol'
  | 'suspicious'
  | 'investigate'
  | 'engage'
  | 'suppress'
  | 'reposition'
  | 'search'
  | 'return'
  | 'eliminated';

export type TransitionReason =
  | 'idle-complete'
  | 'patrol-resumed'
  | 'footstep-heard'
  | 'damage-source'
  | 'visual-cue'
  | 'target-changed'
  | 'suspicion-confirmed'
  | 'target-confirmed'
  | 'tactical-cycle'
  | 'cover-selected'
  | 'no-cover'
  | 'target-occluded'
  | 'investigation-expired'
  | 'memory-expired'
  | 'search-expired'
  | 'returned-home'
  | 'resolved-damage-eliminated';

export type FootstepSurface = SurfaceKind;

/**
 * Local compatibility shape for the canonical `player:footstep` payload.
 * Core currently names the event but does not export its payload interface.
 */
export interface FootstepPayload {
  position: Vec3Like;
  surface: FootstepSurface;
  loud: number;
}

/**
 * Local adapter input supplied after the host resolves damage. This is not a
 * proposed health-authority contract: AI only consumes the resulting values.
 */
export interface ResolvedDamageInput {
  id: string;
  remainingHealth: number;
  maxHealth: number;
  eliminated: boolean;
  sourcePosition?: Vec3Like;
  appliedDamage?: number;
}

export interface MutableTargetSample {
  id: string;
  position: MutableVec3;
  velocity: MutableVec3;
  alive: boolean;
}

/** World-owned target sampling plus the collision/occlusion raycast seam. */
export interface PerceptionRaycastPort {
  sampleTarget(observerId: string, out: MutableTargetSample): boolean;
  isOccluded(origin: Vec3Like, target: Vec3Like, targetId: string): boolean;
}

export interface MutablePathBuffer {
  readonly points: readonly MutableVec3[];
  count: number;
}

/** Host navigation fills the fixed-capacity output buffer; AI owns no nav mesh. */
export interface NavigationPathPort {
  requestPath(
    agentId: string,
    from: Vec3Like,
    to: Vec3Like,
    out: MutablePathBuffer,
  ): number;
  estimatePathCost(agentId: string, from: Vec3Like, to: Vec3Like): number;
}

export interface MutableCoverCandidate {
  id: string;
  position: MutableVec3;
  /** 0 is fully protected, 1 is fully exposed. */
  exposure: number;
  /** Host-provided or estimated traversal cost in world units. */
  pathCost: number;
  /** 0 is frontal, 1 is a strong flank. */
  flank: number;
  score: number;
}

export interface MutableCoverBuffer {
  readonly candidates: readonly MutableCoverCandidate[];
  count: number;
}

/** Candidate generation remains world-owned; the library only scores candidates. */
export interface CoverCandidatePort {
  collectCandidates(
    agentId: string,
    from: Vec3Like,
    target: Vec3Like,
    out: MutableCoverBuffer,
  ): number;
}

/**
 * Integration-neutral combat output. These calls request aim/fire behavior;
 * they do not import a weapon, resolve hits, or emit authoritative Damage.
 */
export interface CombatIntentSink {
  aim(
    agentId: string,
    targetId: string,
    aimPoint: Vec3Like,
    yawErrorRadians: number,
    pitchErrorRadians: number,
    atSeconds: number,
  ): void;
  burst(
    agentId: string,
    targetId: string,
    aimPoint: Vec3Like,
    shotCount: number,
    shotIntervalSeconds: number,
    firstShotAtSeconds: number,
    yawErrorRadians: number,
    pitchErrorRadians: number,
    burstId: number,
    nextBurstNotBeforeSeconds: number,
  ): void;
  suppress(
    agentId: string,
    targetId: string,
    aimPoint: Vec3Like,
    durationSeconds: number,
    atSeconds: number,
  ): void;
  reposition(
    agentId: string,
    coverId: string,
    destination: Vec3Like,
    score: number,
    atSeconds: number,
  ): void;
  cease(agentId: string, reason: 'lost-target' | 'eliminated', atSeconds: number): void;
}

export interface AiObserver {
  transition(
    agentId: string,
    from: AiState,
    to: AiState,
    reason: TransitionReason,
    tick: number,
    atSeconds: number,
  ): void;
}

export interface SecurityAgentPorts {
  perception: PerceptionRaycastPort;
  navigation: NavigationPathPort;
  cover: CoverCandidatePort;
  combat: CombatIntentSink;
  observer?: AiObserver;
}

export interface CoverWeights {
  exposure: number;
  pathCost: number;
  flank: number;
}

export interface SecurityAgentConfig {
  fixedStepSeconds: number;
  visionDistance: number;
  visionHalfAngleRadians: number;
  eyeHeight: number;
  hearingThreshold: number;
  hearingMaxDistance: number;
  suspiciousSeconds: number;
  investigateSeconds: number;
  reactionDelaySeconds: number;
  lostSightGraceSeconds: number;
  memorySampleSeconds: number;
  memoryErrorMeters: number;
  memoryDecayPerSecond: number;
  engageDecisionSeconds: number;
  suppressSeconds: number;
  repositionSeconds: number;
  searchSeconds: number;
  returnSeconds: number;
  idleSeconds: number;
  burstCooldownMinSeconds: number;
  burstCooldownMaxSeconds: number;
  shotIntervalMinSeconds: number;
  shotIntervalMaxSeconds: number;
  aimErrorRadians: number;
  coverWeights: CoverWeights;
  coverPathCostNormalization: number;
  coverTieBreakNoise: number;
}

export interface AgentDebugView {
  state: AiState;
  tick: number;
  timeSeconds: number;
  position: Vec3Like;
  forward: Vec3Like;
  targetVisible: boolean;
  targetId: string;
  confirmationTargetId: string;
  targetPosition: Vec3Like;
  hasLastKnownPosition: boolean;
  memoryTargetId: string;
  lastKnownPosition: Vec3Like;
  memoryConfidence: number;
  hasInterestPosition: boolean;
  interestPosition: Vec3Like;
  path: MutablePathBuffer;
  cover: MutableCoverBuffer;
  selectedCoverIndex: number;
  health: number;
  maxHealth: number;
}

export interface AgentStorageStats {
  ticks: number;
  pathCapacity: number;
  coverCapacity: number;
  maxPathPointsUsed: number;
  maxCoverCandidatesUsed: number;
  pathRequests: number;
  coverQueries: number;
  ownedSetupObjectAllocations: number;
  dynamicTickObjectAllocations: number;
}
