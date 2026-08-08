import {
  MAX_AI_COVER_CANDIDATES,
  MAX_AI_PATH_POINTS,
} from '../SecurityAgent.js';
import { copyVec3, distance, round } from '../math.js';
import type {
  AiObserver,
  AiState,
  CombatIntentSink,
  CoverCandidatePort,
  MutableCoverBuffer,
  MutablePathBuffer,
  MutableTargetSample,
  NavigationPathPort,
  PerceptionRaycastPort,
  TransitionReason,
  Vec3Like,
} from '../types.js';

export interface TraceEvent {
  sequence: number;
  tick: number;
  atSeconds: number;
  kind: 'stimulus' | 'transition' | 'aim' | 'burst' | 'suppress' | 'reposition' | 'cease';
  data: Record<string, unknown>;
}

function vector(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return {
    x: round(x),
    y: round(y),
    z: round(z),
  };
}

function snapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => snapshotValue(item));
  if (value !== null && typeof value === 'object') {
    const snapshot: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      snapshot[key] = snapshotValue(nested);
    }
    return snapshot;
  }
  return value;
}

export class TraceRecorder implements AiObserver, CombatIntentSink {
  readonly events: TraceEvent[] = [];
  private sequence = 0;

  constructor(private readonly capacity = 512) {}

  stimulus(tick: number, label: string, data: Record<string, unknown> = {}): void {
    this.record(tick, tick / 120, 'stimulus', { label, ...data });
  }

  transition(
    agentId: string,
    from: AiState,
    to: AiState,
    reason: TransitionReason,
    tick: number,
    atSeconds: number,
  ): void {
    this.record(tick, atSeconds, 'transition', {
      agentId,
      from,
      to,
      reason,
    });
  }

  aim(
    agentId: string,
    targetId: string,
    aimX: number,
    aimY: number,
    aimZ: number,
    yawErrorRadians: number,
    pitchErrorRadians: number,
    atSeconds: number,
  ): void {
    this.record(Math.round(atSeconds * 120), atSeconds, 'aim', {
      agentId,
      targetId,
      aimPoint: vector(aimX, aimY, aimZ),
      yawErrorRadians: round(yawErrorRadians, 6),
      pitchErrorRadians: round(pitchErrorRadians, 6),
    });
  }

  burst(
    agentId: string,
    targetId: string,
    aimX: number,
    aimY: number,
    aimZ: number,
    shotCount: number,
    shotIntervalSeconds: number,
    firstShotAtSeconds: number,
    yawErrorRadians: number,
    pitchErrorRadians: number,
    burstId: number,
    nextBurstNotBeforeSeconds: number,
  ): void {
    const atSeconds = firstShotAtSeconds - 0.05;
    const finalShotAtSeconds = firstShotAtSeconds
      + (shotCount - 1) * shotIntervalSeconds;
    this.record(Math.round(atSeconds * 120), atSeconds, 'burst', {
      agentId,
      targetId,
      aimPoint: vector(aimX, aimY, aimZ),
      shotCount,
      shotIntervalSeconds: round(shotIntervalSeconds, 6),
      firstShotAtSeconds: round(firstShotAtSeconds, 6),
      yawErrorRadians: round(yawErrorRadians, 6),
      pitchErrorRadians: round(pitchErrorRadians, 6),
      burstId,
      finalShotAtSeconds: round(finalShotAtSeconds, 6),
      cooldownSeconds: round(nextBurstNotBeforeSeconds - finalShotAtSeconds, 6),
      nextBurstNotBeforeSeconds: round(nextBurstNotBeforeSeconds, 6),
    });
  }

  suppress(
    agentId: string,
    targetId: string,
    aimX: number,
    aimY: number,
    aimZ: number,
    durationSeconds: number,
    atSeconds: number,
  ): void {
    this.record(Math.round(atSeconds * 120), atSeconds, 'suppress', {
      agentId,
      targetId,
      aimPoint: vector(aimX, aimY, aimZ),
      durationSeconds: round(durationSeconds),
    });
  }

  reposition(
    agentId: string,
    coverId: string,
    destinationX: number,
    destinationY: number,
    destinationZ: number,
    score: number,
    atSeconds: number,
  ): void {
    this.record(Math.round(atSeconds * 120), atSeconds, 'reposition', {
      agentId,
      coverId,
      destination: vector(destinationX, destinationY, destinationZ),
      score: round(score, 6),
    });
  }

  cease(
    agentId: string,
    reason: 'lost-target' | 'eliminated',
    atSeconds: number,
  ): void {
    this.record(Math.round(atSeconds * 120), atSeconds, 'cease', {
      agentId,
      reason,
    });
  }

  protected snapshotData(data: Record<string, unknown>): Record<string, unknown> {
    return snapshotValue(data) as Record<string, unknown>;
  }

  private record(
    tick: number,
    atSeconds: number,
    kind: TraceEvent['kind'],
    data: Record<string, unknown>,
  ): void {
    if (this.events.length >= this.capacity) {
      throw new Error(`AI evidence trace exceeded its fixed ${this.capacity}-event capacity`);
    }
    this.events.push({
      sequence: this.sequence++,
      tick,
      atSeconds: round(atSeconds, 6),
      kind,
      data: this.snapshotData(data),
    });
  }
}

export const NULL_COMBAT_INTENT_SINK: CombatIntentSink = {
  aim: () => {},
  burst: () => {},
  suppress: () => {},
  reposition: () => {},
  cease: () => {},
};

interface CoverTemplate {
  id: string;
  position: Vec3Like;
  exposure: number;
  flank: number;
}

const COVER_TEMPLATES: readonly CoverTemplate[] = [
  {
    id: 'compressor-left',
    position: { x: -3.8, y: 0, z: 4.6 },
    exposure: 0.2,
    flank: 0.55,
  },
  {
    id: 'barrier-right',
    position: { x: 3.4, y: 0, z: 4.8 },
    exposure: 0.22,
    flank: 0.7,
  },
  {
    id: 'crate-center',
    position: { x: 0.4, y: 0, z: 3.7 },
    exposure: 0.18,
    flank: 0.4,
  },
];

export class ScenarioWorld implements
  PerceptionRaycastPort,
  NavigationPathPort,
  CoverCandidatePort {
  targetPresent = false;
  targetAlive = true;
  occluded = true;
  readonly targetPosition = { x: 0, y: 1.45, z: 9 };
  readonly targetVelocity = { x: 0, y: 0, z: 0 };
  readonly lastCoverTarget = { x: 0, y: 0, z: 0 };
  targetId = 'target-player';
  coverQueryCount = 0;
  pathEstimateOverride: ((from: Vec3Like, to: Vec3Like) => number) | null = null;
  pathNodeCountOverride: ((from: Vec3Like, to: Vec3Like) => number) | null = null;
  candidatePathCostSeed: ((id: string) => number) | null = null;

  sampleTarget(_observerId: string, out: MutableTargetSample): boolean {
    if (!this.targetPresent) return false;
    out.id = this.targetId;
    out.alive = this.targetAlive;
    copyVec3(out.position, this.targetPosition);
    copyVec3(out.velocity, this.targetVelocity);
    return true;
  }

  isOccluded(_origin: Vec3Like, _target: Vec3Like, _targetId: string): boolean {
    return this.occluded;
  }

  requestPath(
    _agentId: string,
    from: Vec3Like,
    to: Vec3Like,
    out: MutablePathBuffer,
  ): number {
    const requestedCount = this.pathNodeCountOverride?.(from, to) ?? 3;
    const count = Math.max(0, Math.min(
      Math.floor(requestedCount),
      MAX_AI_PATH_POINTS,
    ));
    if (count === 0) return 0;
    copyVec3(out.points[0], from);
    if (count === 1) return 1;
    if (count === 2) {
      copyVec3(out.points[1], to);
      return 2;
    }
    out.points[1].x = (from.x + to.x) * 0.5 + (to.x < from.x ? -0.45 : 0.45);
    out.points[1].y = (from.y + to.y) * 0.5;
    out.points[1].z = (from.z + to.z) * 0.5;
    copyVec3(out.points[2], to);
    return count;
  }

  estimatePathCost(_agentId: string, from: Vec3Like, to: Vec3Like): number {
    if (this.pathEstimateOverride) return this.pathEstimateOverride(from, to);
    return distance(from, to) * 1.08;
  }

  collectCandidates(
    _agentId: string,
    _from: Vec3Like,
    target: Vec3Like,
    out: MutableCoverBuffer,
  ): number {
    this.coverQueryCount++;
    copyVec3(this.lastCoverTarget, target);
    const count = Math.min(COVER_TEMPLATES.length, MAX_AI_COVER_CANDIDATES);
    for (let index = 0; index < count; index++) {
      const template = COVER_TEMPLATES[index];
      const candidate = out.candidates[index];
      candidate.id = template.id;
      copyVec3(candidate.position, template.position);
      candidate.exposure = template.exposure;
      candidate.pathCost = this.candidatePathCostSeed?.(template.id) ?? 0;
      candidate.flank = template.flank;
      candidate.score = 0;
    }
    return count;
  }
}
