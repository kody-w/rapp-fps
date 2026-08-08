import {
  AI_FIXED_STEP_SECONDS,
  DEFAULT_SECURITY_AGENT_CONFIG,
  SecurityAgent,
} from '../SecurityAgent.js';
import { FixedStepAccumulator } from '../FixedStepAccumulator.js';
import { distance, round } from '../math.js';
import type {
  AgentDebugView,
  AgentStorageStats,
  CombatIntentSink,
  FootstepPayload,
  SecurityAgentConfig,
  SecurityAgentPorts,
  Vec3Like,
} from '../types.js';
import {
  NULL_COMBAT_INTENT_SINK,
  ScenarioWorld,
  TraceRecorder,
  type TraceEvent,
} from './world.js';

const FIXED_HZ = 120;
const DEFAULT_SEED = 0x51c0_7a11;
const ALT_SEED = 0xa17e_22d3;
const QUIET_FOOTSTEP: FootstepPayload = {
  position: { x: 0, y: 0, z: 18 },
  surface: 'metal',
  loud: 0.08,
};

export interface EvidenceAssertion {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  summary: string;
}

interface ScenarioResult {
  passed: boolean;
  seed: number;
  durationSeconds: number;
  finalState: string;
  timeline: readonly TraceEvent[];
  assertions: readonly EvidenceAssertion[];
  debug?: Record<string, unknown>;
}

interface ScenarioContext {
  agent: SecurityAgent;
  world: ScenarioWorld;
  trace: TraceRecorder;
}

class AllocatingSecurityAgentMutation extends SecurityAgent {
  override fixedUpdate(stepSeconds = AI_FIXED_STEP_SECONDS): void {
    void this.ownDynamicTickObject({ mutation: 'per-tick-allocation' });
    super.fixedUpdate(stepSeconds);
  }
}

class ShallowTraceRecorderMutation extends TraceRecorder {
  protected override snapshotData(data: Record<string, unknown>): Record<string, unknown> {
    return data;
  }
}

class RetainedIntentSink implements CombatIntentSink {
  firstBurst: Record<string, unknown> | null = null;

  constructor(
    private readonly aliasedAimSource: (() => Vec3Like) | null = null,
  ) {}

  aim(
    _agentId: string,
    _targetId: string,
    _aimX: number,
    _aimY: number,
    _aimZ: number,
    _yawErrorRadians: number,
    _pitchErrorRadians: number,
    _atSeconds: number,
  ): void {}

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
    if (this.firstBurst) return;
    this.firstBurst = {
      agentId,
      targetId,
      aimPoint: this.aliasedAimSource?.() ?? { x: aimX, y: aimY, z: aimZ },
      shotCount,
      shotIntervalSeconds,
      firstShotAtSeconds,
      yawErrorRadians,
      pitchErrorRadians,
      burstId,
      nextBurstNotBeforeSeconds,
    };
  }

  suppress(
    _agentId: string,
    _targetId: string,
    _aimX: number,
    _aimY: number,
    _aimZ: number,
    _durationSeconds: number,
    _atSeconds: number,
  ): void {}

  reposition(
    _agentId: string,
    _coverId: string,
    _destinationX: number,
    _destinationY: number,
    _destinationZ: number,
    _score: number,
    _atSeconds: number,
  ): void {}

  cease(
    _agentId: string,
    _reason: 'lost-target' | 'eliminated',
    _atSeconds: number,
  ): void {}
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function check(
  name: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
): EvidenceAssertion {
  return {
    name,
    passed,
    expected,
    actual,
    summary: `${passed ? 'PASS' : 'FAIL'} ${name}: expected ${valueText(expected)}; `
      + `actual ${valueText(actual)}`,
  };
}

function createContext(
  seed = DEFAULT_SEED,
  overrides: Partial<SecurityAgentConfig> = {},
  world = new ScenarioWorld(),
  trace = new TraceRecorder(),
): ScenarioContext {
  const agent = new SecurityAgent(
    'security-01',
    seed,
    {
      perception: world,
      navigation: world,
      cover: world,
      combat: trace,
      observer: trace,
    },
    overrides,
  );
  agent.setPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  agent.setHome({ x: 0, y: 0, z: -1.5 });
  trace.stimulus(0, 'scenario-start', { state: 'patrol', seed });
  return { agent, world, trace };
}

function tick(
  context: ScenarioContext,
  ticks: number,
  beforeTick?: (tickIndex: number, context: ScenarioContext) => void,
): void {
  for (let tickIndex = 0; tickIndex < ticks; tickIndex++) {
    beforeTick?.(tickIndex, context);
    context.agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
  }
}

function transitionStates(events: readonly TraceEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'transition')
    .map((event) => String(event.data.to));
}

function findTransition(events: readonly TraceEvent[], to: string): TraceEvent | undefined {
  return events.find(
    (event) => event.kind === 'transition' && event.data.to === to,
  );
}

function finalState(agent: SecurityAgent): string {
  return agent.getDebugView().state;
}

function finishScenario(
  context: ScenarioContext,
  durationSeconds: number,
  assertions: EvidenceAssertion[],
  debug?: Record<string, unknown>,
): ScenarioResult {
  return {
    passed: assertions.every((assertion) => assertion.passed),
    seed: Number(context.trace.events[0]?.data.seed ?? DEFAULT_SEED),
    durationSeconds,
    finalState: finalState(context.agent),
    timeline: context.trace.events,
    assertions,
    debug,
  };
}

function runPatrolSilence(): ScenarioResult {
  const context = createContext();
  context.world.targetPresent = true;
  context.world.occluded = true;
  const durationSeconds = 2;
  tick(context, durationSeconds * FIXED_HZ);
  const states = transitionStates(context.trace.events);
  const assertions = [
    check('no LOS plus no sound stays patrol', finalState(context.agent) === 'patrol', 'patrol', finalState(context.agent)),
    check('occluded target produces no state transition', states.length === 0, [], states),
  ];
  return finishScenario(context, durationSeconds, assertions);
}

function runSoundInvestigation(): ScenarioResult {
  const context = createContext();
  const durationSeconds = 2.6;
  const footstep: FootstepPayload = {
    position: { x: 4, y: 0, z: 4 },
    surface: 'metal',
    loud: 0.82,
  };
  let accepted = false;
  tick(context, Math.round(durationSeconds * FIXED_HZ), (tickIndex) => {
    if (tickIndex !== 12) return;
    context.trace.stimulus(tickIndex, 'Footstep', {
      position: footstep.position,
      surface: footstep.surface,
      loud: footstep.loud,
    });
    accepted = context.agent.hearFootstep(footstep);
  });
  const states = transitionStates(context.trace.events);
  const assertions = [
    check('audible canonical Footstep is consumed', accepted, true, accepted),
    check('sound enters suspicious', states.includes('suspicious'), true, states),
    check('sound advances to investigate', states.includes('investigate'), true, states),
    check('sound alone never enters engage', !states.includes('engage'), false, states.includes('engage')),
  ];
  return finishScenario(context, durationSeconds, assertions);
}

function runQuietFootstep(
  overrides: Partial<SecurityAgentConfig> = {},
): ScenarioResult {
  const context = createContext(DEFAULT_SEED, overrides);
  const durationSeconds = 1;
  let accepted = false;
  tick(context, durationSeconds * FIXED_HZ, (tickIndex) => {
    if (tickIndex !== 6) return;
    context.trace.stimulus(tickIndex, 'quiet-Footstep', {
      position: QUIET_FOOTSTEP.position,
      loud: QUIET_FOOTSTEP.loud,
    });
    accepted = context.agent.hearFootstep(QUIET_FOOTSTEP);
  });
  const states = transitionStates(context.trace.events);
  const assertions = [
    check('subthreshold Footstep is rejected', !accepted, false, accepted),
    check('subthreshold Footstep leaves patrol unchanged', states.length === 0, [], states),
  ];
  return finishScenario(context, durationSeconds, assertions, { accepted });
}

function runReactionDelay(
  overrides: Partial<SecurityAgentConfig> = {},
  expectedMinimumSeconds = DEFAULT_SECURITY_AGENT_CONFIG.reactionDelaySeconds,
): ScenarioResult {
  const context = createContext(DEFAULT_SEED, overrides);
  const durationSeconds = 2;
  context.world.occluded = false;
  tick(context, durationSeconds * FIXED_HZ, (tickIndex) => {
    if (tickIndex === 24) {
      context.trace.stimulus(tickIndex, 'LOS-confirmable', {
        position: context.world.targetPosition,
      });
      context.world.targetPresent = true;
    }
  });
  const visual = context.trace.events.find(
    (event) => event.kind === 'transition' && event.data.reason === 'visual-cue',
  );
  const engage = findTransition(context.trace.events, 'engage');
  const delaySeconds = visual && engage
    ? (engage.tick - visual.tick) * AI_FIXED_STEP_SECONDS
    : null;
  const burst = context.trace.events.find((event) => event.kind === 'burst');
  const states = transitionStates(context.trace.events);
  const assertions = [
    check('LOS first creates a suspicious visual cue', Boolean(visual), true, Boolean(visual)),
    check('confirmed LOS eventually enters engage', Boolean(engage), true, Boolean(engage)),
    check(
      'LOS reaction delay is preserved before engage',
      delaySeconds !== null && delaySeconds + 1e-9 >= expectedMinimumSeconds,
      `>= ${expectedMinimumSeconds}s`,
      delaySeconds === null ? null : `${round(delaySeconds, 6)}s`,
    ),
    check(
      'burst intent is not scheduled before engage',
      Boolean(burst && engage && burst.tick >= engage.tick),
      'first burst tick >= engage tick',
      { burstTick: burst?.tick ?? null, engageTick: engage?.tick ?? null },
    ),
  ];
  return finishScenario(context, durationSeconds, assertions, {
    states,
    reactionDelaySeconds: delaySeconds,
  });
}

function runOcclusionMemory(): ScenarioResult {
  const context = createContext();
  const durationSeconds = 7.2;
  const occlusionTick = 228;
  const memorySamples: { tick: number; confidence: number; state: string }[] = [];
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.trace.stimulus(0, 'LOS-on', { position: context.world.targetPosition });
  tick(context, Math.round(durationSeconds * FIXED_HZ), (tickIndex) => {
    if (tickIndex === occlusionTick) {
      context.trace.stimulus(tickIndex, 'occlusion-on');
      memorySamples.push({
        tick: tickIndex,
        confidence: context.agent.getDebugView().memoryConfidence,
        state: context.agent.getDebugView().state,
      });
      context.world.occluded = true;
    }
    if (tickIndex === occlusionTick + 180) {
      memorySamples.push({
        tick: tickIndex,
        confidence: context.agent.getDebugView().memoryConfidence,
        state: context.agent.getDebugView().state,
      });
    }
  });
  const states = transitionStates(context.trace.events);
  const search = findTransition(context.trace.events, 'search');
  const returning = findTransition(context.trace.events, 'return');
  const firstConfidence = memorySamples[0]?.confidence ?? 0;
  const laterConfidence = memorySamples[1]?.confidence ?? 1;
  const assertions = [
    check('occlusion after engage enters search', Boolean(search), true, Boolean(search)),
    check(
      'target memory decays while occluded',
      laterConfidence < firstConfidence,
      `< ${round(firstConfidence)}`,
      round(laterConfidence),
    ),
    check(
      'search transitions to return after memory is no longer actionable',
      Boolean(search && returning && returning.tick > search.tick),
      'return tick > search tick',
      { searchTick: search?.tick ?? null, returnTick: returning?.tick ?? null },
    ),
    check(
      'return completes through idle back to patrol',
      finalState(context.agent) === 'patrol',
      'patrol',
      finalState(context.agent),
    ),
  ];
  return finishScenario(context, durationSeconds, assertions, {
    occlusionTick,
    memorySamples: memorySamples.map((sample) => ({
      ...sample,
      confidence: round(sample.confidence, 6),
    })),
    states,
  });
}

function runOccludedTargetCoverMemory(): ScenarioResult {
  const context = createContext();
  const occlusionTick = 250;
  const durationTicks = 310;
  const rememberedAtOcclusion = { x: 0, y: 0, z: 0 };
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.trace.stimulus(0, 'LOS-on', { position: context.world.targetPosition });

  tick(context, durationTicks, (tickIndex) => {
    if (tickIndex !== occlusionTick) return;
    const memory = context.agent.getDebugView().lastKnownPosition;
    rememberedAtOcclusion.x = memory.x;
    rememberedAtOcclusion.y = memory.y;
    rememberedAtOcclusion.z = memory.z;
    context.trace.stimulus(tickIndex, 'occlusion-and-target-move', {
      rememberedAtOcclusion: { ...rememberedAtOcclusion },
      liveDestination: { x: 12, y: 1.45, z: 20 },
    });
    context.world.occluded = true;
    context.world.targetPosition.x = 12;
    context.world.targetPosition.z = 20;
  });

  const memoryDistance = distance(context.world.lastCoverTarget, rememberedAtOcclusion);
  const liveDistance = distance(context.world.lastCoverTarget, context.world.targetPosition);
  const reposition = context.trace.events.find((event) => event.kind === 'reposition');
  const historicalLos = context.trace.events.find(
    (event) => event.kind === 'stimulus' && event.data.label === 'LOS-on',
  );
  const historicalPosition = historicalLos?.data.position as
    | { x: number; y: number; z: number }
    | undefined;
  const assertions = [
    check('cover is evaluated during the occlusion grace window', context.world.coverQueryCount > 0, '> 0', context.world.coverQueryCount),
    check(
      'occluded cover scoring uses last-known target memory',
      memoryDistance <= 1e-9,
      rememberedAtOcclusion,
      context.world.lastCoverTarget,
    ),
    check(
      'occluded moving target does not leak live coordinates into cover scoring',
      liveDistance > 5,
      '> 5m from moved live target',
      `${round(liveDistance, 6)}m`,
    ),
    check('memory-based cover can still produce a reposition intent', Boolean(reposition), true, Boolean(reposition)),
    check(
      'tick-0 LOS history remains original after tick-250 target movement',
      Boolean(
        historicalPosition
        && distance(historicalPosition, { x: 0, y: 1.45, z: 9 }) <= 1e-9
      ),
      { x: 0, y: 1.45, z: 9 },
      historicalPosition ?? null,
    ),
  ];
  return finishScenario(context, durationTicks / FIXED_HZ, assertions, {
    occlusionTick,
    rememberedAtOcclusion,
    movedLiveTarget: { ...context.world.targetPosition },
    coverQueryTarget: { ...context.world.lastCoverTarget },
    historicalLosPosition: historicalPosition ?? null,
    memoryDistance: round(memoryDistance, 6),
    liveDistance: round(liveDistance, 6),
  });
}

function runMixedCoverReachability(): ScenarioResult {
  const world = new ScenarioWorld();
  world.candidatePathCostSeed = (id) => id === 'compressor-left' ? -1_000 : 0;
  world.pathEstimateOverride = (_from, to) => (
    to.x < -3
      ? Number.NaN
      : Math.abs(to.x) < 1
        ? 0
        : 17
  );
  world.pathNodeCountOverride = (_from, to) => (
    Math.abs(to.x) < 1 ? 0 : 3
  );
  const context = createContext(DEFAULT_SEED, {}, world);
  const durationTicks = 310;
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.trace.stimulus(0, 'LOS-on');
  tick(context, durationTicks);

  const reposition = context.trace.events.find((event) => event.kind === 'reposition');
  const coverId = String(reposition?.data.coverId ?? '');
  const stats = context.agent.getStorageStats();
  const assertions = [
    check(
      'non-finite estimate rejects a candidate despite stale low path cost',
      coverId !== 'compressor-left',
      'not compressor-left',
      coverId,
    ),
    check(
      'zero-node candidate loses to a reachable candidate',
      coverId === 'barrier-right',
      'barrier-right',
      coverId,
    ),
    check(
      'reposition is emitted only with a usable staged path',
      Boolean(reposition && context.agent.getDebugView().path.count >= 2),
      'pathCount >= 2',
      context.agent.getDebugView().path.count,
    ),
    check('cover selection probes alternate routes after rejection', stats.pathRequests >= 2, '>= 2', stats.pathRequests),
  ];
  return finishScenario(context, durationTicks / FIXED_HZ, assertions, {
    selectedCover: coverId,
    pathCount: context.agent.getDebugView().path.count,
    pathRequests: stats.pathRequests,
  });
}

function runAllCoverUnreachable(): ScenarioResult {
  const world = new ScenarioWorld();
  world.pathNodeCountOverride = () => 0;
  const context = createContext(DEFAULT_SEED, {}, world);
  const durationTicks = 310;
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.trace.stimulus(0, 'LOS-on');
  tick(context, durationTicks);

  const reposition = context.trace.events.find((event) => event.kind === 'reposition');
  const repositionState = findTransition(context.trace.events, 'reposition');
  const noCover = context.trace.events.find(
    (event) => event.kind === 'transition' && event.data.reason === 'no-cover',
  );
  const assertions = [
    check('all unreachable cover emits no reposition intent', !reposition, false, Boolean(reposition)),
    check('all unreachable cover never enters reposition', !repositionState, false, Boolean(repositionState)),
    check('all unreachable cover falls back through no-cover', Boolean(noCover), true, Boolean(noCover)),
    check('failed cover leaves no staged path', context.agent.getDebugView().path.count === 0, 0, context.agent.getDebugView().path.count),
  ];
  return finishScenario(context, durationTicks / FIXED_HZ, assertions, {
    pathRequests: context.agent.getStorageStats().pathRequests,
  });
}

function runBurstBoundaryRegression(): ScenarioResult {
  const context = createContext(67);
  const durationTicks = 1_205;
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.trace.stimulus(0, 'LOS-on', { seed: 67 });
  tick(context, durationTicks);

  const boundary = context.trace.events.find(
    (event) => (
      event.kind === 'transition'
      && event.tick === 1_192
      && event.data.from === 'engage'
      && event.data.to === 'suppress'
    ),
  );
  const bursts = context.trace.events.filter((event) => event.kind === 'burst');
  const boundaryBursts = bursts.filter((event) => event.tick === 1_192);
  const duplicateTicks = bursts
    .filter((event, index) => bursts.findIndex((other) => other.tick === event.tick) !== index)
    .map((event) => event.tick);
  const deadlineViolations = bursts.slice(1).flatMap((event, index) => {
    const previous = bursts[index];
    const deadline = Number(previous.data.nextBurstNotBeforeSeconds);
    return event.atSeconds + 1e-6 < deadline
      ? [{
        previousBurstId: previous.data.burstId,
        nextBurstId: event.data.burstId,
        nextScheduledAt: event.atSeconds,
        requiredDeadline: deadline,
      }]
      : [];
  });
  const assertions = [
    check('seed 67 reaches the reviewed engage-to-suppress boundary', Boolean(boundary), 'tick 1192', boundary?.tick ?? null),
    check(
      'tactical boundary schedules at most one burst',
      boundaryBursts.length <= 1,
      '0..1',
      boundaryBursts.map((event) => event.data.burstId),
    ),
    check('burst schedule has no duplicate tick emissions', duplicateTicks.length === 0, [], duplicateTicks),
    check(
      'every burst waits for the previous final-shot plus cooldown deadline',
      deadlineViolations.length === 0,
      [],
      deadlineViolations,
    ),
  ];
  return finishScenario(context, durationTicks / FIXED_HZ, assertions, {
    boundaryTick: boundary?.tick ?? null,
    boundaryBurstIds: boundaryBursts.map((event) => event.data.burstId),
    deadlineViolations,
  });
}

function runBurstCooldownDeadline(): ScenarioResult {
  const context = createContext(DEFAULT_SEED);
  const durationTicks = 340;
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.trace.stimulus(0, 'LOS-on');
  tick(context, durationTicks);

  const transition = context.trace.events.find(
    (event) => (
      event.kind === 'transition'
      && event.data.from === 'engage'
      && event.data.to === 'suppress'
    ),
  );
  const bursts = context.trace.events.filter((event) => event.kind === 'burst');
  const priorBurst = transition
    ? bursts.filter((event) => event.tick < transition.tick).at(-1)
    : undefined;
  const nextBurst = priorBurst
    ? bursts.find((event) => event.sequence > priorBurst.sequence)
    : undefined;
  const priorFinalShot = Number(priorBurst?.data.finalShotAtSeconds);
  const priorDeadline = Number(priorBurst?.data.nextBurstNotBeforeSeconds);
  const nextScheduledAt = nextBurst?.atSeconds ?? null;
  const assertions = [
    check('reviewed engage-to-suppress transition is present', Boolean(transition), true, Boolean(transition)),
    check(
      'transition occurs while the prior burst still has scheduled shots',
      Boolean(transition && priorBurst && transition.atSeconds < priorFinalShot),
      `transition before ${round(priorFinalShot, 6)}s final shot`,
      transition?.atSeconds ?? null,
    ),
    check(
      'next burst waits through prior final shot and cooldown',
      Boolean(nextBurst && nextScheduledAt !== null && nextScheduledAt + 1e-6 >= priorDeadline),
      `>= ${round(priorDeadline, 6)}s`,
      nextScheduledAt,
    ),
  ];
  return finishScenario(context, durationTicks / FIXED_HZ, assertions, {
    transitionAtSeconds: transition?.atSeconds ?? null,
    priorBurst: priorBurst
      ? {
        burstId: priorBurst.data.burstId,
        scheduledAtSeconds: priorBurst.atSeconds,
        finalShotAtSeconds: priorFinalShot,
        nextBurstNotBeforeSeconds: priorDeadline,
      }
      : null,
    nextBurst: nextBurst
      ? {
        burstId: nextBurst.data.burstId,
        scheduledAtSeconds: nextBurst.atSeconds,
      }
      : null,
  });
}

function runTargetIdentityReaction(): ScenarioResult {
  const context = createContext();
  const switchTick = 30;
  const durationTicks = 120;
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.world.targetId = 'target-a';
  context.trace.stimulus(0, 'LOS-on', { targetId: 'target-a' });
  tick(context, durationTicks, (tickIndex) => {
    if (tickIndex !== switchTick) return;
    context.world.targetId = 'target-b';
    context.world.targetPosition.x = 2;
    context.trace.stimulus(tickIndex, 'target-identity-switch', {
      from: 'target-a',
      to: 'target-b',
    });
  });

  const engage = findTransition(context.trace.events, 'engage');
  const detectionTick = switchTick + 1;
  const delaySeconds = engage
    ? (engage.tick - detectionTick) * AI_FIXED_STEP_SECONDS
    : null;
  const firstBurst = context.trace.events.find((event) => event.kind === 'burst');
  const debug = context.agent.getDebugView();
  const assertions = [
    check('target B eventually enters engage', Boolean(engage), true, Boolean(engage)),
    check(
      'target B receives the full reaction delay',
      delaySeconds !== null
        && delaySeconds + 1e-9 >= DEFAULT_SECURITY_AGENT_CONFIG.reactionDelaySeconds,
      `>= ${DEFAULT_SECURITY_AGENT_CONFIG.reactionDelaySeconds}s`,
      delaySeconds === null ? null : `${round(delaySeconds, 6)}s`,
    ),
    check('first burst after the switch targets B', firstBurst?.data.targetId === 'target-b', 'target-b', firstBurst?.data.targetId ?? null),
    check('memory sampling resets to target B', debug.memoryTargetId === 'target-b', 'target-b', debug.memoryTargetId),
    check('confirmation identity tracks target B', debug.confirmationTargetId === 'target-b', 'target-b', debug.confirmationTargetId),
  ];
  return finishScenario(context, durationTicks / FIXED_HZ, assertions, {
    switchTick,
    detectionTick,
    engageTick: engage?.tick ?? null,
    delaySeconds,
  });
}

function runOccludedRetargetMemoryIdentity(): ScenarioResult {
  const context = createContext();
  const switchTick = 180;
  const durationTicks = 210;
  const rememberedA = { x: 0, y: 0, z: 0 };
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.world.targetId = 'target-a';
  context.trace.stimulus(0, 'LOS-on', { targetId: 'target-a' });

  tick(context, durationTicks, (tickIndex) => {
    if (tickIndex !== switchTick) return;
    const memory = context.agent.getDebugView().lastKnownPosition;
    rememberedA.x = memory.x;
    rememberedA.y = memory.y;
    rememberedA.z = memory.z;
    context.world.occluded = true;
    context.world.targetId = 'target-b';
    context.world.targetPosition.x = 12;
    context.world.targetPosition.z = 20;
    context.trace.stimulus(tickIndex, 'occluded-retarget', {
      memoryTargetId: 'target-a',
      sampledTargetId: 'target-b',
      rememberedA: { ...rememberedA },
    });
  });

  const suppression = context.trace.events.find(
    (event) => event.kind === 'suppress' && event.tick >= switchTick,
  );
  const suppressionPoint = suppression?.data.aimPoint as
    | { x: number; y: number; z: number }
    | undefined;
  const memoryDistance = suppressionPoint
    ? distance(suppressionPoint, rememberedA)
    : Number.POSITIVE_INFINITY;
  const mismatchedMemoryEvents = context.trace.events.filter((event) => {
    if (
      event.tick < switchTick
      || (event.kind !== 'aim' && event.kind !== 'burst' && event.kind !== 'suppress')
      || event.data.targetId !== 'target-b'
    ) return false;
    const point = event.data.aimPoint as
      | { x: number; y: number; z: number }
      | undefined;
    return point !== undefined && distance(point, rememberedA) < 0.01;
  });
  const assertions = [
    check('occluded retarget reaches suppression during A memory grace', Boolean(suppression), true, Boolean(suppression)),
    check('suppression at A memory keeps target A identity', suppression?.data.targetId === 'target-a', 'target-a', suppression?.data.targetId ?? null),
    check('suppression coordinates remain at A memory', memoryDistance < 0.001, '< 0.001m', `${round(memoryDistance, 6)}m`),
    check('no combat intent labels A memory as target B', mismatchedMemoryEvents.length === 0, [], mismatchedMemoryEvents),
  ];
  return finishScenario(context, durationTicks / FIXED_HZ, assertions, {
    switchTick,
    rememberedA,
    sampledTargetB: { ...context.world.targetPosition },
    suppressionTargetId: suppression?.data.targetId ?? null,
    suppressionPoint: suppressionPoint ?? null,
    memoryDistance: round(memoryDistance, 6),
  });
}

function runRetainedBurstOwnership(
  aliasedAimSource = false,
): ScenarioResult {
  const world = new ScenarioWorld();
  const trace = new TraceRecorder();
  let agent!: SecurityAgent;
  const sink = new RetainedIntentSink(
    aliasedAimSource
      ? () => agent.getDebugView().lastKnownPosition
      : null,
  );
  agent = new SecurityAgent(
    'security-01',
    DEFAULT_SEED,
    {
      perception: world,
      navigation: world,
      cover: world,
      combat: sink,
      observer: trace,
    },
  );
  agent.setPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  agent.setHome({ x: 0, y: 0, z: -1.5 });
  trace.stimulus(0, 'scenario-start', {
    state: 'patrol',
    seed: DEFAULT_SEED,
    mutation: aliasedAimSource ? 'aliased-aim-reference' : 'scalar-owned-aim',
  });
  const context = { agent, world, trace };
  world.targetPresent = true;
  world.occluded = false;
  trace.stimulus(0, 'LOS-on', { position: world.targetPosition });

  let guardTicks = 0;
  while (!sink.firstBurst && guardTicks < 120) {
    agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
    guardTicks++;
  }
  const beforeBytes = JSON.stringify(sink.firstBurst);
  const memoryAtBurst = { ...agent.getDebugView().lastKnownPosition };
  while (agent.getDebugView().tick < 75) {
    agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
  }
  const afterBytes = JSON.stringify(sink.firstBurst);
  const memoryAfterUpdate = { ...agent.getDebugView().lastKnownPosition };
  const firstShotAt = Number(sink.firstBurst?.firstShotAtSeconds);
  const shotCount = Number(sink.firstBurst?.shotCount);
  const shotInterval = Number(sink.firstBurst?.shotIntervalSeconds);
  const finalShotAt = firstShotAt + (shotCount - 1) * shotInterval;
  const observationAt = agent.getDebugView().timeSeconds;
  const memoryMoved = distance(memoryAtBurst, memoryAfterUpdate);
  const assertions = [
    check('first burst intent is retained by the sink', sink.firstBurst !== null, true, sink.firstBurst !== null),
    check('later memory sampling changes the reusable source vector', memoryMoved > 0.001, '> 0.001m', `${round(memoryMoved, 6)}m`),
    check('ownership probe runs before the retained burst final shot', observationAt < finalShotAt, `< ${round(finalShotAt, 6)}s`, round(observationAt, 6)),
    check(
      'retained burst intent remains byte-identical through memory updates',
      beforeBytes === afterBytes,
      fnv1a(beforeBytes),
      fnv1a(afterBytes),
    ),
  ];
  return finishScenario(context, observationAt, assertions, {
    aliasedAimSource,
    capturedAtTick: guardTicks,
    observedAtTick: agent.getDebugView().tick,
    finalShotAtSeconds: round(finalShotAt, 6),
    observationAtSeconds: round(observationAt, 6),
    memoryMovedMeters: round(memoryMoved, 6),
    beforeHash: fnv1a(beforeBytes),
    afterHash: fnv1a(afterBytes),
    retainedBurst: sink.firstBurst,
  });
}

function runStimulusValueOwnership(
  trace = new TraceRecorder(),
): ScenarioResult {
  const world = new ScenarioWorld();
  const context = createContext(DEFAULT_SEED, {}, world, trace);
  const originalPosition = { ...world.targetPosition };
  trace.stimulus(0, 'LOS-on', { position: world.targetPosition });
  const historical = trace.events.find(
    (event) => event.kind === 'stimulus' && event.data.label === 'LOS-on',
  );
  const beforeBytes = JSON.stringify(historical);
  world.targetPosition.x = 12;
  world.targetPosition.z = 20;
  const afterBytes = JSON.stringify(historical);
  const recordedPosition = historical?.data.position as
    | { x: number; y: number; z: number }
    | undefined;
  const assertions = [
    check(
      'historical tick-0 LOS position remains the original value',
      Boolean(recordedPosition && distance(recordedPosition, originalPosition) <= 1e-9),
      originalPosition,
      recordedPosition ?? null,
    ),
    check(
      'nested stimulus history remains byte-identical after source mutation',
      beforeBytes === afterBytes,
      fnv1a(beforeBytes),
      fnv1a(afterBytes),
    ),
  ];
  return finishScenario(context, 0, assertions, {
    originalPosition,
    movedSourcePosition: { ...world.targetPosition },
    recordedPosition: recordedPosition ?? null,
    beforeHash: fnv1a(beforeBytes),
    afterHash: fnv1a(afterBytes),
  });
}

function runTacticalTrace(seed: number): ScenarioResult {
  const context = createContext(seed);
  const durationSeconds = 4.6;
  context.world.targetPresent = true;
  context.world.occluded = false;
  context.trace.stimulus(0, 'LOS-on', { position: context.world.targetPosition });
  tick(context, Math.round(durationSeconds * FIXED_HZ));
  const states = transitionStates(context.trace.events);
  const tacticalEvents = context.trace.events.filter(
    (event) => event.kind === 'burst' || event.kind === 'reposition',
  );
  const assertions = [
    check('tactical trace reaches engage', states.includes('engage'), true, states),
    check('tactical trace reaches suppress', states.includes('suppress'), true, states),
    check('tactical trace reaches reposition', states.includes('reposition'), true, states),
    check('burst scheduler emits bounded intents', tacticalEvents.length > 0 && tacticalEvents.length < 32, '1..31', tacticalEvents.length),
  ];
  return finishScenario(context, durationSeconds, assertions, {
    tacticalEvents,
  });
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stateTimeline(events: readonly TraceEvent[]): { state: string; tick: number }[] {
  return events
    .filter((event) => event.kind === 'transition')
    .map((event) => ({ state: String(event.data.to), tick: event.tick }));
}

function runSeedDeterminism(): {
  passed: boolean;
  assertions: EvidenceAssertion[];
  sameSeedHash: string;
  alternateSeedHash: string;
  trace: readonly TraceEvent[];
  alternateTacticalChoices: readonly TraceEvent[];
} {
  const first = runTacticalTrace(DEFAULT_SEED);
  const replay = runTacticalTrace(DEFAULT_SEED);
  const alternate = runTacticalTrace(ALT_SEED);
  const firstBytes = JSON.stringify(first.timeline);
  const replayBytes = JSON.stringify(replay.timeline);
  const alternateBytes = JSON.stringify(alternate.timeline);
  const firstStates = stateTimeline(first.timeline);
  const alternateStates = stateTimeline(alternate.timeline);
  const sameStateShape = firstStates.length === alternateStates.length
    && firstStates.every((state, index) => alternateStates[index]?.state === state.state);
  const maxTimingDelta = sameStateShape
    ? firstStates.reduce((max, state, index) => {
    const other = alternateStates[index];
    if (!other) return Number.POSITIVE_INFINITY;
    return Math.max(max, Math.abs(other.tick - state.tick) * AI_FIXED_STEP_SECONDS);
      }, 0)
    : Number.POSITIVE_INFINITY;
  const firstTactics = first.timeline.filter(
    (event) => event.kind === 'burst' || event.kind === 'reposition',
  );
  const alternateTactics = alternate.timeline.filter(
    (event) => event.kind === 'burst' || event.kind === 'reposition',
  );
  const assertions = [
    check('same seed and input are byte-identical', firstBytes === replayBytes, fnv1a(firstBytes), fnv1a(replayBytes)),
    check('different seed changes tactical choices', JSON.stringify(firstTactics) !== JSON.stringify(alternateTactics), 'different tactical bytes', {
      first: fnv1a(JSON.stringify(firstTactics)),
      alternate: fnv1a(JSON.stringify(alternateTactics)),
    }),
    check('different seed preserves the state sequence', sameStateShape, firstStates, alternateStates),
    check('different seed preserves bounded state timing', maxTimingDelta <= 0.25, '<= 0.25s', `${round(maxTimingDelta, 6)}s`),
    ...first.assertions,
    ...alternate.assertions,
  ];
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    sameSeedHash: fnv1a(firstBytes),
    alternateSeedHash: fnv1a(alternateBytes),
    trace: first.timeline,
    alternateTacticalChoices: alternateTactics,
  };
}

interface BatchingRun {
  renderHz: number;
  renderFrames: number;
  fixedTicks: number;
  renderSeconds: number;
  simulatedSeconds: number;
  commonTimeSnapshot: Record<string, unknown> | null;
  commonTimelineHash: string | null;
  timeline: readonly TraceEvent[];
  hash: string;
}

function runBatchedTimeline(
  renderHz: 30 | 60 | 144,
  accumulatorRate = 1,
): BatchingRun {
  const context = createContext(DEFAULT_SEED);
  const renderFrames = 180;
  const commonTicks = 150;
  const accumulator = new FixedStepAccumulator(AI_FIXED_STEP_SECONDS);
  let completedTicks = 0;
  let commonTimeSnapshot: Record<string, unknown> | null = null;
  let commonTimelineHash: string | null = null;
  let stimulusIndex = 0;
  const footstep: FootstepPayload = {
    position: { x: -3, y: 0, z: 3 },
    surface: 'concrete',
    loud: 0.75,
  };
  const stimuli = [
    { atSeconds: 0.15, kind: 'footstep' },
    { atSeconds: 0.55, kind: 'los' },
    { atSeconds: 1.6, kind: 'occlusion' },
  ] as const;

  const fixedUpdate = (stepSeconds: number): void => {
    const simulationSeconds = completedTicks * stepSeconds;
    while (
      stimulusIndex < stimuli.length
      && stimuli[stimulusIndex].atSeconds <= simulationSeconds + 1e-9
    ) {
      const stimulus = stimuli[stimulusIndex++];
      if (stimulus.kind === 'footstep') {
        context.trace.stimulus(completedTicks, 'Footstep', {
          atSeconds: stimulus.atSeconds,
          loud: footstep.loud,
        });
        context.agent.hearFootstep(footstep);
      } else if (stimulus.kind === 'los') {
        context.trace.stimulus(completedTicks, 'LOS-on', {
          atSeconds: stimulus.atSeconds,
        });
        context.world.targetPresent = true;
        context.world.occluded = false;
      } else {
        context.trace.stimulus(completedTicks, 'occlusion-on', {
          atSeconds: stimulus.atSeconds,
        });
        context.world.occluded = true;
      }
    }
    context.agent.fixedUpdate(stepSeconds);
    completedTicks++;
    if (completedTicks === commonTicks) {
      const prefix = context.trace.events.filter((event) => event.tick <= commonTicks);
      const debug = context.agent.getDebugView();
      commonTimelineHash = fnv1a(JSON.stringify(prefix));
      commonTimeSnapshot = {
        tick: completedTicks,
        state: debug.state,
        targetVisible: debug.targetVisible,
        memoryConfidence: round(debug.memoryConfidence, 6),
        pathCount: debug.path.count,
        timelineHash: commonTimelineHash,
      };
    }
  };

  for (let frame = 0; frame < renderFrames; frame++) {
    accumulator.advance((1 / renderHz) * accumulatorRate, fixedUpdate);
  }

  const accumulatorSnapshot = accumulator.snapshot();
  const bytes = JSON.stringify(context.trace.events);
  return {
    renderHz,
    renderFrames,
    fixedTicks: accumulatorSnapshot.completedTicks,
    renderSeconds: round(renderFrames / renderHz, 6),
    simulatedSeconds: round(accumulatorSnapshot.simulatedSeconds, 6),
    commonTimeSnapshot,
    commonTimelineHash,
    timeline: context.trace.events,
    hash: fnv1a(bytes),
  };
}

function runBatchingDeterminism(): {
  passed: boolean;
  assertions: EvidenceAssertion[];
  runs: BatchingRun[];
  mutationControl: Record<string, unknown>;
} {
  const runs = [
    runBatchedTimeline(30),
    runBatchedTimeline(60),
    runBatchedTimeline(144),
  ];
  const expectedTicks = runs.map((run) => Math.floor(
    run.renderFrames / run.renderHz / AI_FIXED_STEP_SECONDS + 1e-9,
  ));
  const commonSnapshot = JSON.stringify(runs[0].commonTimeSnapshot);
  const assertions = [
    check(
      'fixed render-frame counts produce expected differing fixed-tick coverage',
      runs.every((run, index) => run.fixedTicks === expectedTicks[index])
        && new Set(runs.map((run) => run.fixedTicks)).size === runs.length,
      expectedTicks,
      runs.map((run) => run.fixedTicks),
    ),
    check(
      'render-frame runs report their actual elapsed coverage',
      runs.every((run) => Math.abs(run.simulatedSeconds - run.fixedTicks / FIXED_HZ) <= 1e-9),
      runs.map((run) => run.fixedTicks / FIXED_HZ),
      runs.map((run) => run.simulatedSeconds),
    ),
    ...runs.slice(1).map((run) => check(
      `${run.renderHz} Hz matches 30 Hz at the common 1.25 simulated seconds`,
      JSON.stringify(run.commonTimeSnapshot) === commonSnapshot,
      runs[0].commonTimeSnapshot,
      run.commonTimeSnapshot,
    )),
  ];
  const wrongRate = runBatchedTimeline(60, 0.5);
  const wrongRateAssertion = check(
    '60 Hz accumulator advances at the render delta rate',
    wrongRate.fixedTicks === expectedTicks[1],
    expectedTicks[1],
    wrongRate.fixedTicks,
  );
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    runs,
    mutationControl: {
      name: 'wrong accumulator rate',
      mutation: 'render delta multiplied by 0.5',
      passed: false,
      expectedFailureObserved: !wrongRateAssertion.passed,
      relevantAssertion: wrongRateAssertion.name,
      failureSummary: wrongRateAssertion.summary,
      actual: {
        fixedTicks: wrongRate.fixedTicks,
        simulatedSeconds: wrongRate.simulatedSeconds,
      },
    },
  };
}

function storageSummary(stats: readonly Readonly<AgentStorageStats>[]): Record<string, number> {
  return {
    agents: stats.length,
    totalTicks: stats.reduce((sum, value) => sum + value.ticks, 0),
    pathCapacityPerAgent: stats[0]?.pathCapacity ?? 0,
    coverCapacityPerAgent: stats[0]?.coverCapacity ?? 0,
    maxPathPointsUsed: Math.max(...stats.map((value) => value.maxPathPointsUsed)),
    maxCoverCandidatesUsed: Math.max(...stats.map((value) => value.maxCoverCandidatesUsed)),
    pathRequests: stats.reduce((sum, value) => sum + value.pathRequests, 0),
    coverQueries: stats.reduce((sum, value) => sum + value.coverQueries, 0),
    ownedSetupObjectAllocationsPerAgent: stats[0]?.ownedSetupObjectAllocations ?? 0,
    dynamicTickObjectAllocations: stats.reduce(
      (sum, value) => sum + value.dynamicTickObjectAllocations,
      0,
    ),
  };
}

function createBenchmarkAgents(count: number, world: ScenarioWorld): SecurityAgent[] {
  const agents: SecurityAgent[] = [];
  for (let index = 0; index < count; index++) {
    const agent = new SecurityAgent(
      `security-${String(index).padStart(2, '0')}`,
      (DEFAULT_SEED + index * 0x9e37_79b9) >>> 0,
      {
        perception: world,
        navigation: world,
        cover: world,
        combat: NULL_COMBAT_INTENT_SINK,
      },
    );
    agent.setPose(
      { x: (index % 10) * 0.15, y: 0, z: -Math.floor(index / 10) * 0.15 },
      { x: 0, y: 0, z: 1 },
    );
    agents.push(agent);
  }
  return agents;
}

function runBenchmark(): {
  passed: boolean;
  assertions: EvidenceAssertion[];
  simulatedSeconds: number;
  enemies: number;
  elapsedCpuMs: number;
  cpuMsPerFixedStep: number;
  budget: Record<string, unknown>;
  storage: Record<string, number>;
} {
  const warmWorld = new ScenarioWorld();
  warmWorld.targetPresent = true;
  warmWorld.occluded = false;
  const warmAgents = createBenchmarkAgents(8, warmWorld);
  for (let tickIndex = 0; tickIndex < 240; tickIndex++) {
    for (const agent of warmAgents) agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
  }

  const enemies = 50;
  const simulatedSeconds = 60;
  const fixedTicks = simulatedSeconds * FIXED_HZ;
  const cpuBudgetMsPerFixedStep = 0.75;
  const world = new ScenarioWorld();
  world.targetPresent = true;
  world.occluded = false;
  const agents = createBenchmarkAgents(enemies, world);
  const benchmarkFootstep: FootstepPayload = {
    position: { x: 2, y: 0, z: 5 },
    surface: 'concrete',
    loud: 0.7,
  };

  const started = performance.now();
  for (let tickIndex = 0; tickIndex < fixedTicks; tickIndex++) {
    if (tickIndex > 0 && tickIndex % 900 === 0) {
      world.occluded = !world.occluded;
    }
    if (tickIndex > 0 && tickIndex % 1_440 === 0) {
      for (const agent of agents) agent.hearFootstep(benchmarkFootstep);
    }
    for (const agent of agents) agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
  }
  const elapsedCpuMs = performance.now() - started;
  const cpuMsPerFixedStep = elapsedCpuMs / fixedTicks;
  const stats = agents.map((agent) => agent.getStorageStats());
  const storage = storageSummary(stats);
  const bounded = stats.every((value) => (
    value.pathCapacity === 16
    && value.coverCapacity === 12
    && value.maxPathPointsUsed <= value.pathCapacity
    && value.maxCoverCandidatesUsed <= value.coverCapacity
    && value.ownedSetupObjectAllocations > 0
    && value.dynamicTickObjectAllocations === 0
  ));
  const assertions = [
    check(
      '50 enemies for 60 simulated seconds stay within CPU budget',
      cpuMsPerFixedStep <= cpuBudgetMsPerFixedStep,
      `<= ${cpuBudgetMsPerFixedStep} ms per 120 Hz fixed step`,
      `${round(cpuMsPerFixedStep, 6)} ms`,
    ),
    check(
      'benchmark executes every agent tick',
      storage.totalTicks === enemies * fixedTicks,
      enemies * fixedTicks,
      storage.totalTicks,
    ),
    check(
      'instrumented owned storage remains fixed-capacity with zero dynamic fixed-step allocations',
      bounded,
      {
        pathCapacity: 16,
        coverCapacity: 12,
        ownedSetupObjectAllocations: '> 0',
        dynamicTickObjectAllocations: 0,
      },
      storage,
    ),
    check(
      'benchmark exercises navigation and cover seams',
      storage.pathRequests > 0 && storage.coverQueries > 0,
      'pathRequests > 0 and coverQueries > 0',
      {
        pathRequests: storage.pathRequests,
        coverQueries: storage.coverQueries,
      },
    ),
  ];
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    simulatedSeconds,
    enemies,
    elapsedCpuMs: round(elapsedCpuMs, 3),
    cpuMsPerFixedStep: round(cpuMsPerFixedStep, 6),
    budget: {
      cpuMsPerFixedStep: cpuBudgetMsPerFixedStep,
      shareOf120HzFrame: round(cpuBudgetMsPerFixedStep / (1000 / FIXED_HZ), 3),
      verdict: cpuMsPerFixedStep <= cpuBudgetMsPerFixedStep ? 'PASS' : 'FAIL',
    },
    storage,
  };
}

function runAllocationMutationControl(): Record<string, unknown> {
  const world = new ScenarioWorld();
  const trace = new TraceRecorder();
  const ports: SecurityAgentPorts = {
    perception: world,
    navigation: world,
    cover: world,
    combat: trace,
    observer: trace,
  };
  const agent = new AllocatingSecurityAgentMutation(
    'allocation-mutation',
    DEFAULT_SEED,
    ports,
  );
  agent.setPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  for (let tickIndex = 0; tickIndex < 120; tickIndex++) {
    agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
  }
  const stats = agent.getStorageStats();
  const assertion = check(
    'agent owns zero dynamic fixed-step allocations',
    stats.dynamicTickObjectAllocations === 0,
    0,
    stats.dynamicTickObjectAllocations,
  );
  return {
    name: 'per-tick owned allocation',
    mutation: 'subclass allocates and registers one object during every fixedUpdate',
    passed: false,
    expectedFailureObserved: !assertion.passed,
    relevantAssertion: assertion.name,
    failureSummary: assertion.summary,
    setupAllocationsObserved: stats.ownedSetupObjectAllocations,
    dynamicTickObjectAllocations: stats.dynamicTickObjectAllocations,
  };
}

function runResolvedDamageSeam(): ScenarioResult {
  const context = createContext();
  context.trace.stimulus(0, 'resolved-damage-input', {
    remainingHealth: 42,
    maxHealth: 100,
    eliminated: false,
  });
  const acceptedDamage = context.agent.consumeResolvedDamage({
    id: 'security-01',
    remainingHealth: 42,
    maxHealth: 100,
    eliminated: false,
    sourcePosition: { x: -4, y: 1, z: 2 },
    appliedDamage: 18,
  });
  tick(context, 12);
  const burstCountBeforeElimination = context.trace.events.filter(
    (event) => event.kind === 'burst',
  ).length;
  context.trace.stimulus(12, 'resolved-damage-input', {
    remainingHealth: 0,
    maxHealth: 100,
    eliminated: true,
  });
  const acceptedElimination = context.agent.consumeResolvedDamage({
    id: 'security-01',
    remainingHealth: 0,
    maxHealth: 100,
    eliminated: true,
  });
  tick(context, 120);
  const burstCountAfterElimination = context.trace.events.filter(
    (event) => event.kind === 'burst',
  ).length;
  const cease = context.trace.events.find(
    (event) => event.kind === 'cease' && event.data.reason === 'eliminated',
  );
  const assertions = [
    check('host-resolved damage input is accepted', acceptedDamage, true, acceptedDamage),
    check('host-resolved elimination input is accepted', acceptedElimination, true, acceptedElimination),
    check('elimination enters terminal state', finalState(context.agent) === 'eliminated', 'eliminated', finalState(context.agent)),
    check('elimination emits cease intent rather than Damage', Boolean(cease), true, Boolean(cease)),
    check('eliminated AI schedules no further bursts', burstCountAfterElimination === burstCountBeforeElimination, burstCountBeforeElimination, burstCountAfterElimination),
  ];
  return finishScenario(context, 1.1, assertions);
}

function runLethalDamagePriority(): ScenarioResult {
  const context = createContext();
  const accepted = context.agent.consumeResolvedDamage({
    id: 'security-01',
    remainingHealth: 0,
    maxHealth: 100,
    eliminated: true,
    sourcePosition: { x: 5, y: 1, z: -2 },
    appliedDamage: 100,
  });
  const transitions = context.trace.events.filter((event) => event.kind === 'transition');
  const assertions = [
    check('lethal resolved damage input is accepted', accepted, true, accepted),
    check(
      'lethal damage produces one direct patrol-to-eliminated transition',
      transitions.length === 1
        && transitions[0]?.data.from === 'patrol'
        && transitions[0]?.data.to === 'eliminated',
      [{ from: 'patrol', to: 'eliminated' }],
      transitions.map((event) => ({ from: event.data.from, to: event.data.to })),
    ),
    check(
      'lethal damage never emits an intermediate suspicious transition',
      !transitions.some((event) => event.data.to === 'suspicious'),
      false,
      transitions.some((event) => event.data.to === 'suspicious'),
    ),
  ];
  return finishScenario(context, 0, assertions);
}

function runSearchDamageRefresh(): ScenarioResult {
  const context = createContext();
  const footstep: FootstepPayload = {
    position: { x: 3, y: 0, z: 4 },
    surface: 'metal',
    loud: 0.9,
  };
  context.agent.hearFootstep(footstep);
  let guardTicks = 0;
  while (context.agent.getDebugView().state !== 'search' && guardTicks < 600) {
    context.agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
    guardTicks++;
  }
  const searchEntry = findTransition(context.trace.events, 'search');
  const searchDurationTicks = Math.ceil(
    DEFAULT_SECURITY_AGENT_CONFIG.searchSeconds / AI_FIXED_STEP_SECONDS,
  );
  tick(context, searchDurationTicks - 1);

  const source = { x: 7, y: 0, z: -3 };
  const damageTick = context.agent.getDebugView().tick;
  const accepted = context.agent.consumeResolvedDamage({
    id: 'security-01',
    remainingHealth: 65,
    maxHealth: 100,
    eliminated: false,
    sourcePosition: source,
    appliedDamage: 35,
  });
  const immediate = context.agent.getDebugView();
  const pathEnd = immediate.path.count > 0
    ? immediate.path.points[immediate.path.count - 1]
    : null;
  const immediateState = immediate.state;
  const immediatePathDistance = pathEnd
    ? distance(pathEnd, source)
    : Number.POSITIVE_INFINITY;
  context.agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
  const nextTickState = context.agent.getDebugView().state;
  const damageTransition = context.trace.events.find(
    (event) => (
      event.kind === 'transition'
      && event.tick === damageTick
      && event.data.from === 'search'
      && event.data.to === 'investigate'
      && event.data.reason === 'damage-source'
    ),
  );
  const prematureReturn = context.trace.events.find(
    (event) => (
      event.kind === 'transition'
      && event.data.to === 'return'
      && event.tick >= damageTick
      && event.tick <= damageTick + 1
    ),
  );
  const assertions = [
    check('search state is reached before the sourced hit', Boolean(searchEntry), true, Boolean(searchEntry)),
    check('surviving sourced damage is accepted', accepted, true, accepted),
    check('search hit immediately restarts investigate', immediateState === 'investigate', 'investigate', immediateState),
    check('search hit replaces the path with the damage source', immediatePathDistance <= 1e-9, source, pathEnd),
    check('refreshed investigate persists through the next fixed tick', nextTickState === 'investigate', 'investigate', nextTickState),
    check('search hit does not immediately expire to return', !prematureReturn, false, Boolean(prematureReturn)),
    check('search hit records a damage-source transition', Boolean(damageTransition), true, Boolean(damageTransition)),
  ];
  return finishScenario(context, context.agent.getDebugView().timeSeconds, assertions, {
    searchEntryTick: searchEntry?.tick ?? null,
    damageTick,
    immediateState,
    nextTickState,
    pathEnd,
    pathDistance: round(immediatePathDistance, 6),
  });
}

function negativeControl(
  name: string,
  mutation: string,
  result: ScenarioResult,
  relevantAssertion: string,
): Record<string, unknown> {
  const failure = result.assertions.find(
    (assertion) => assertion.name === relevantAssertion && !assertion.passed,
  );
  return {
    name,
    mutation,
    passed: false,
    expectedFailureObserved: Boolean(failure),
    relevantAssertion,
    failureSummary: failure?.summary ?? 'Mutation unexpectedly passed its relevant assertion',
    timeline: result.timeline,
  };
}

function snapshotDebug(view: Readonly<AgentDebugView>): Record<string, unknown> {
  return {
    state: view.state,
    tick: view.tick,
    memoryConfidence: round(view.memoryConfidence, 6),
    pathCount: view.path.count,
    coverCount: view.cover.count,
    selectedCoverIndex: view.selectedCoverIndex,
  };
}

export function runEvidenceSuite(): Record<string, unknown> {
  const patrolSilence = runPatrolSilence();
  const soundInvestigation = runSoundInvestigation();
  const hearingThreshold = runQuietFootstep();
  const reactionDelay = runReactionDelay();
  const occlusionMemory = runOcclusionMemory();
  const occludedCoverMemory = runOccludedTargetCoverMemory();
  const mixedCoverReachability = runMixedCoverReachability();
  const allCoverUnreachable = runAllCoverUnreachable();
  const burstBoundary = runBurstBoundaryRegression();
  const burstCooldownDeadline = runBurstCooldownDeadline();
  const targetIdentityReaction = runTargetIdentityReaction();
  const occludedRetargetMemoryIdentity = runOccludedRetargetMemoryIdentity();
  const retainedBurstOwnership = runRetainedBurstOwnership();
  const stimulusValueOwnership = runStimulusValueOwnership();
  const seedDeterminism = runSeedDeterminism();
  const batchingDeterminism = runBatchingDeterminism();
  const benchmark = runBenchmark();
  const resolvedDamage = runResolvedDamageSeam();
  const lethalDamagePriority = runLethalDamagePriority();
  const searchDamageRefresh = runSearchDamageRefresh();
  const allocationMutation = runAllocationMutationControl();

  const reactionMutation = runReactionDelay(
    { reactionDelaySeconds: 0 },
    DEFAULT_SECURITY_AGENT_CONFIG.reactionDelaySeconds,
  );
  const hearingMutation = runQuietFootstep({ hearingThreshold: 0 });
  const retainedBurstAliasMutation = runRetainedBurstOwnership(true);
  const shallowStimulusMutation = runStimulusValueOwnership(
    new ShallowTraceRecorderMutation(),
  );
  const negativeControls = [
    negativeControl(
      'reaction delay removal',
      'reactionDelaySeconds = 0',
      reactionMutation,
      'LOS reaction delay is preserved before engage',
    ),
    negativeControl(
      'hearing threshold removal',
      'hearingThreshold = 0',
      hearingMutation,
      'subthreshold Footstep leaves patrol unchanged',
    ),
    batchingDeterminism.mutationControl,
    allocationMutation,
    negativeControl(
      'retained burst aim alias',
      'sink retains the reusable last-known-position reference',
      retainedBurstAliasMutation,
      'retained burst intent remains byte-identical through memory updates',
    ),
    negativeControl(
      'shallow nested stimulus copy',
      'trace recorder stores nested stimulus references without value snapshotting',
      shallowStimulusMutation,
      'nested stimulus history remains byte-identical after source mutation',
    ),
  ];
  const controlsPassed = negativeControls.every(
    (control) => control.expectedFailureObserved === true,
  );
  const scenarios = {
    patrolSilence,
    soundInvestigation,
    hearingThreshold,
    reactionDelay,
    occlusionMemory,
    occludedCoverMemory,
    mixedCoverReachability,
    allCoverUnreachable,
    burstBoundary,
    burstCooldownDeadline,
    targetIdentityReaction,
    occludedRetargetMemoryIdentity,
    retainedBurstOwnership,
    stimulusValueOwnership,
    resolvedDamage,
    lethalDamagePriority,
    searchDamageRefresh,
  };
  const baselinePassed = Object.values(scenarios).every((scenario) => scenario.passed);
  const passed = baselinePassed
    && seedDeterminism.passed
    && batchingDeterminism.passed
    && benchmark.passed
    && controlsPassed;

  return {
    schemaVersion: 1,
    passed,
    fixedStep: {
      hz: FIXED_HZ,
      seconds: AI_FIXED_STEP_SECONDS,
    },
    behavior: {
      archetype: 'industrial-security',
      stateFlow: [
        'idle',
        'patrol',
        'suspicious',
        'investigate',
        'engage',
        'suppress',
        'reposition',
        'search',
        'return',
        'eliminated',
      ],
    },
    scenarios,
    determinism: seedDeterminism,
    renderBatching: batchingDeterminism,
    benchmark,
    negativeControls,
    allocationPolicy: {
      tickScratch: 'preallocated vectors, target sample, path buffer, and cover buffer',
      instrumentation: 'Every SecurityAgent-owned setup object is counted at its allocation site; future dynamic fixed-step objects must pass through ownDynamicTickObject.',
      tracePolicy: 'evidence-only fixed 512-event cap; production observer is optional',
      verdict: benchmark.storage.dynamicTickObjectAllocations === 0 ? 'PASS' : 'FAIL',
    },
    sharedContractRequests: {
      promote: [
        {
          name: 'FootstepPayload',
          shape: '{ position: Vector3Like, surface: SurfaceKind, loud: number }',
          evidence: 'Core names player:footstep with this shape; audio and this AI harness now consume the same fields.',
        },
      ],
      deferUntilIntegrationProvesShape: [
        'PerceptionRaycastPort',
        'NavigationPathPort',
        'CombatIntentSink',
        'ResolvedDamageInput',
      ],
      coordinatorRequest: 'Promote the proven canonical Footstep payload. Keep the other AI-local seams private until real collision, navigation, combat, and health adapters validate them.',
    },
    caveats: {
      integration: 'No player, weapon, authored level, collision mesh, navigation mesh, or health authority is integrated.',
      visuals: 'No character model or animation is provided; the visual harness uses an abstract debug proxy.',
      feel: 'Subjective combat feel remains unverified until real player, weapon, movement, cover, and authored-space contracts land.',
    },
    debugProbe: snapshotDebug(createContext().agent.getDebugView()),
  };
}
