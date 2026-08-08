import {
  AI_FIXED_STEP_SECONDS,
  DEFAULT_SECURITY_AGENT_CONFIG,
  SecurityAgent,
} from '../SecurityAgent.js';
import { round } from '../math.js';
import type {
  AgentDebugView,
  AgentStorageStats,
  FootstepPayload,
  SecurityAgentConfig,
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
): ScenarioContext {
  const world = new ScenarioWorld();
  const trace = new TraceRecorder();
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

function runBatchedTimeline(renderHz: 30 | 60 | 144): {
  renderHz: number;
  renderFrames: number;
  fixedTicks: number;
  timeline: readonly TraceEvent[];
  hash: string;
} {
  const context = createContext(DEFAULT_SEED);
  const clockHz = 720;
  const fixedUnits = clockHz / FIXED_HZ;
  const renderUnits = clockHz / renderHz;
  const fixedTicks = 6 * FIXED_HZ;
  let accumulator = 0;
  let completedTicks = 0;
  let renderFrames = 0;

  while (completedTicks < fixedTicks) {
    accumulator += renderUnits;
    renderFrames++;
    while (accumulator >= fixedUnits && completedTicks < fixedTicks) {
      if (completedTicks === 18) {
        const footstep: FootstepPayload = {
          position: { x: -3, y: 0, z: 3 },
          surface: 'concrete',
          loud: 0.75,
        };
        context.trace.stimulus(completedTicks, 'Footstep', { loud: footstep.loud });
        context.agent.hearFootstep(footstep);
      }
      if (completedTicks === 96) {
        context.trace.stimulus(completedTicks, 'LOS-on');
        context.world.targetPresent = true;
        context.world.occluded = false;
      }
      if (completedTicks === 330) {
        context.trace.stimulus(completedTicks, 'occlusion-on');
        context.world.occluded = true;
      }
      context.agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
      accumulator -= fixedUnits;
      completedTicks++;
    }
  }

  const bytes = JSON.stringify(context.trace.events);
  return {
    renderHz,
    renderFrames,
    fixedTicks: completedTicks,
    timeline: context.trace.events,
    hash: fnv1a(bytes),
  };
}

function runBatchingDeterminism(): {
  passed: boolean;
  assertions: EvidenceAssertion[];
  runs: ReturnType<typeof runBatchedTimeline>[];
} {
  const runs = [
    runBatchedTimeline(30),
    runBatchedTimeline(60),
    runBatchedTimeline(144),
  ];
  const baseline = JSON.stringify(runs[0].timeline);
  const assertions = runs.slice(1).map((run) => check(
    `${run.renderHz} Hz render batching matches 30 Hz fixed-step timeline`,
    JSON.stringify(run.timeline) === baseline,
    runs[0].hash,
    run.hash,
  ));
  assertions.push(check(
    'all render batches execute exactly 720 fixed ticks',
    runs.every((run) => run.fixedTicks === 720),
    [720, 720, 720],
    runs.map((run) => run.fixedTicks),
  ));
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    runs,
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
      'tick storage remains fixed-capacity with zero dynamic tick objects',
      bounded,
      {
        pathCapacity: 16,
        coverCapacity: 12,
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
  const seedDeterminism = runSeedDeterminism();
  const batchingDeterminism = runBatchingDeterminism();
  const benchmark = runBenchmark();
  const resolvedDamage = runResolvedDamageSeam();

  const reactionMutation = runReactionDelay(
    { reactionDelaySeconds: 0 },
    DEFAULT_SECURITY_AGENT_CONFIG.reactionDelaySeconds,
  );
  const hearingMutation = runQuietFootstep({ hearingThreshold: 0 });
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
    resolvedDamage,
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
