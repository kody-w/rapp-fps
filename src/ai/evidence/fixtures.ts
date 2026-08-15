/**
 * Browser-free evidence for the enemy AI.
 *
 * This module is the witness the reviewer reads instead of a summary. It builds
 * five sections and refuses (marks `ok: false`, and the runner exits non-zero)
 * if any claim fails:
 *
 *  1. reachability — one scenario per transition, driving inputs until each edge
 *     fires, plus a check that NO edge fires that is not in the declared table
 *     and that EVERY declared edge fires at least once. This is the exact defect
 *     that blocked PR #24, inverted into a pass/fail gate.
 *  2. lineOfSight — positive and, crucially, negative cases: a player behind a
 *     box, behind a pillar, out of the cone, out of range — all must NOT be seen.
 *  3. determinism — same seed + same inputs, run twice, byte-identical logs.
 *  4. renderRate — the same fixed steps delivered on 30/60/144/240 fps frame
 *     schedules produce identical state; behaviour does not depend on render rate.
 *  5. cpu — worst-of-three per-step cost for the shipped enemy count.
 *
 * Everything is pure arithmetic on plain numbers; there is no renderer here.
 */

import {
  AI_FIXED_STEP_SECONDS,
  ARENA_ENEMY_SPAWN,
  ARENA_ENEMY_YAW,
  DEFAULT_ENEMY_CONFIG,
  EnemyAgent,
  buildArena,
  canSee,
  lineOfSightClear,
} from '../index.js';
import type {
  AiState,
  EnemyConfig,
  StaticWorld,
  StepInput,
  Transition,
  TransitionReason,
  Vec3,
} from '../index.js';

const STEP = AI_FIXED_STEP_SECONDS;

function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

function makeConfig(partial: Partial<EnemyConfig> = {}): EnemyConfig {
  return { ...DEFAULT_ENEMY_CONFIG, ...partial };
}

// ── Scenario framework ─────────────────────────────────────────────────────

interface ScriptCtx {
  tick: number;
  time: number;
  agent: EnemyAgent;
}

interface Scenario {
  name: string;
  note: string;
  config?: Partial<EnemyConfig>;
  spawn?: Vec3;
  yaw?: number;
  seconds: number;
  script: (ctx: ScriptCtx) => StepInput;
}

interface SimResult {
  agent: EnemyAgent;
  transitions: Transition[];
}

function runScenario(scenario: Scenario): SimResult {
  const config = makeConfig(scenario.config);
  const arena = buildArena();
  const agent = new EnemyAgent(config, arena.world, arena.cover, arena.halfExtent, {
    spawn: scenario.spawn ?? ARENA_ENEMY_SPAWN,
    yaw: scenario.yaw ?? ARENA_ENEMY_YAW,
  });
  const steps = Math.round(scenario.seconds / STEP);
  for (let i = 0; i < steps; i++) {
    const time = (i + 1) * STEP;
    const input = scenario.script({ tick: i + 1, time, agent });
    agent.fixedStep(STEP, input);
  }
  return { agent, transitions: agent.transitions.slice() };
}

// ── Player scripting helpers ───────────────────────────────────────────────

interface Key {
  t: number;
  x: number;
  z: number;
}

/** Piecewise-linear player position over time. */
function pathAt(keys: readonly Key[], time: number): Vec3 {
  if (time <= keys[0].t) return v3(keys[0].x, 0, keys[0].z);
  for (let i = 1; i < keys.length; i++) {
    if (time <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const span = b.t - a.t || 1;
      const u = (time - a.t) / span;
      return v3(a.x + (b.x - a.x) * u, 0, a.z + (b.z - a.z) * u);
    }
  }
  const last = keys[keys.length - 1];
  return v3(last.x, 0, last.z);
}

const PLAYER_ID = 'player';

function target(pos: Vec3, alive = true): StepInput['target'] {
  return { id: PLAYER_ID, position: pos, alive };
}

// ── The declared transition table ──────────────────────────────────────────
// Every edge the machine may take. Reachability = every row fires, and nothing
// outside this set ever fires.

interface Edge {
  from: AiState | '*';
  to: AiState;
  reason: TransitionReason;
}

const DECLARED_EDGES: readonly Edge[] = [
  { from: 'patrol', to: 'investigate', reason: 'heard' },
  { from: 'patrol', to: 'engage', reason: 'spotted' },
  { from: 'investigate', to: 'engage', reason: 'confirmed' },
  { from: 'investigate', to: 'patrol', reason: 'lost-interest' },
  { from: 'engage', to: 'reposition', reason: 'repositioning' },
  { from: 'reposition', to: 'engage', reason: 'in-position' },
  { from: 'engage', to: 'search', reason: 'lost-sight' },
  { from: 'reposition', to: 'search', reason: 'lost-sight' },
  { from: 'search', to: 'engage', reason: 'reacquired' },
  { from: 'search', to: 'patrol', reason: 'abandoned' },
  // The death guard is one edge reachable from ANY live state; `from` is the
  // wildcard `*`, and the checker records which concrete states were observed.
  { from: '*', to: 'dead', reason: 'killed' },
];

const LIVE_STATES: ReadonlySet<string> = new Set([
  'patrol', 'investigate', 'engage', 'reposition', 'search',
]);

function edgeKey(from: string, to: string, reason: string): string {
  return `${from}>${to}>${reason}`;
}

// ── Reachability scenarios ─────────────────────────────────────────────────

/** A footstep the enemy will hear, placed next to its home stance. */
function nearFootstep(time: number, window: [number, number]): StepInput['footsteps'] {
  if (time >= window[0] && time <= window[1]) {
    return [{ position: v3(1.2, 0, -5), loud: 1 }];
  }
  return undefined;
}

function buildScenarios(): Scenario[] {
  // Player walks the open lane from behind the pillar into full view, then holds
  // — long enough to be spotted and to dwell in cover past the reposition timer.
  const approachHold: Key[] = [
    { t: 0, x: 0, z: 8.5 },
    { t: 3, x: 0, z: 1.0 },
    { t: 20, x: 0, z: 1.0 },
  ];

  // Same approach, then duck hard left behind hide-l to break sight.
  const approachHide: Key[] = [
    { t: 0, x: 0, z: 8.5 },
    { t: 2.5, x: 0, z: 1.0 },
    { t: 3.5, x: 0, z: 1.0 },
    { t: 4.3, x: -2.6, z: 2.4 },
    { t: 20, x: -2.6, z: 2.4 },
  ];

  // Approach, hide, then re-emerge into the lane.
  const approachHideReturn: Key[] = [
    { t: 0, x: 0, z: 8.5 },
    { t: 2.5, x: 0, z: 1.0 },
    { t: 3.5, x: 0, z: 1.0 },
    { t: 4.3, x: -2.6, z: 2.4 },
    { t: 7.5, x: -2.6, z: 2.4 },
    { t: 8.5, x: 0, z: 1.0 },
    { t: 20, x: 0, z: 1.0 },
  ];

  return [
    {
      name: 'approach-dwell-reposition',
      note: 'Player emerges, is spotted, and is held in view long enough to dwell '
        + 'in cover and reposition, then settle back to engage.',
      seconds: 14,
      script: ({ time }) => ({ target: target(pathAt(approachHold, time)) }),
    },
    {
      name: 'heard-lost-interest',
      note: 'A footstep in range with the player kept out of sight behind the pillar: '
        + 'investigate, then give up.',
      seconds: 6,
      script: ({ time }) => ({
        // Player stays far behind the central pillar, never in the cone/line.
        target: target(v3(0, 0, 9)),
        footsteps: nearFootstep(time, [0.4, 0.5]),
      }),
    },
    {
      name: 'heard-then-confirm',
      note: 'A footstep starts an investigation, then the player steps into view and is confirmed.',
      seconds: 6,
      script: ({ time }) => ({
        target: target(pathAt([
          { t: 0, x: 0, z: 9 },
          { t: 1.5, x: 0, z: 9 },
          { t: 3, x: 0, z: 1.5 },
          { t: 10, x: 0, z: 1.5 },
        ], time)),
        footsteps: nearFootstep(time, [0.4, 0.5]),
      }),
    },
    {
      name: 'engage-lose-sight-abandon',
      note: 'Spotted, then the player ducks behind cover and stays hidden until the search times out.',
      seconds: 13,
      script: ({ time }) => ({ target: target(pathAt(approachHide, time)) }),
    },
    {
      name: 'engage-lose-sight-reacquire',
      note: 'Spotted, sight is broken into a search, then the player re-emerges and is reacquired.',
      seconds: 11,
      script: ({ time }) => ({ target: target(pathAt(approachHideReturn, time)) }),
    },
    {
      name: 'reposition-lose-sight',
      note: 'Spotted, damage forces a reposition, and the player hides during the move so sight '
        + 'is lost mid-reposition. Runs under the DEFAULT config — no guard tuning.',
      seconds: 9,
      script: ({ time, agent }) => {
        // Visible until the reposition begins, then hidden behind hide-l.
        const visible = pathAt([
          { t: 0, x: 0, z: 8.5 },
          { t: 3, x: 0, z: 1.0 },
          { t: 20, x: 0, z: 1.0 },
        ], time);
        const hidden = v3(-2.6, 0, 2.4);
        const pos = agent.state === 'reposition' ? hidden : visible;
        // One damage pulse once engaged, to trigger the reposition.
        const damage = agent.state === 'engage' && agent.shotsFired >= 0 && time > 4 && time < 4.02
          ? [{ amount: 12, sourcePosition: v3(-2, 0, 3) }]
          : undefined;
        return { target: target(pos), damage };
      },
    },
    {
      name: 'killed-from-engage',
      note: 'Spotted, then a lethal hit while engaged.',
      seconds: 8,
      script: ({ time }) => ({
        target: target(pathAt([
          { t: 0, x: 0, z: 8.5 },
          { t: 3, x: 0, z: 1.0 },
          { t: 20, x: 0, z: 1.0 },
        ], time)),
        damage: time > 5 && time < 5.02 ? [{ amount: 200, sourcePosition: v3(0, 0, 3) }] : undefined,
      }),
    },
    {
      name: 'killed-from-patrol',
      note: 'A lethal hit while patrolling, with no target ever seen — killed is reachable '
        + 'from a non-combat state too.',
      seconds: 3,
      script: ({ time }) => ({
        target: target(v3(0, 0, 9)), // stays hidden behind the pillar
        damage: time > 1 && time < 1.02 ? [{ amount: 200, sourcePosition: v3(0, 0, 3) }] : undefined,
      }),
    },
  ];
}

interface ReachabilityRow {
  from: string;
  to: string;
  reason: string;
  firedBy: string | null;
  tick: number | null;
  time: number | null;
  /** For the wildcard death edge: the concrete from-states observed. */
  observedFroms?: string[];
}

interface ReachabilityReport {
  ok: boolean;
  failures: string[];
  rows: ReachabilityRow[];
  scenarioLog: Array<{
    scenario: string;
    note: string;
    config: string;
    transitions: Array<{ from: string; to: string; reason: string; tick: number; time: number }>;
  }>;
}

function runReachability(): ReachabilityReport {
  const scenarios = buildScenarios();
  const declared = new Map<string, ReachabilityRow>();
  for (const e of DECLARED_EDGES) {
    declared.set(edgeKey(e.from, e.to, e.reason), {
      from: e.from, to: e.to, reason: e.reason, firedBy: null, tick: null, time: null,
    });
  }

  const failures: string[] = [];
  const scenarioLog: ReachabilityReport['scenarioLog'] = [];
  const killedKey = edgeKey('*', 'dead', 'killed');
  const killedRow = declared.get(killedKey);
  if (killedRow) killedRow.observedFroms = [];

  for (const scenario of scenarios) {
    const { transitions } = runScenario(scenario);
    scenarioLog.push({
      scenario: scenario.name,
      note: scenario.note,
      config: scenario.config ? JSON.stringify(scenario.config) : 'default',
      transitions: transitions.map((t) => ({
        from: t.from, to: t.to, reason: t.reason, tick: t.tick, time: +t.time.toFixed(3),
      })),
    });
    for (const t of transitions) {
      // The death guard is a wildcard edge: any live state may take it.
      const isKilled = t.to === 'dead' && t.reason === 'killed';
      const key = isKilled ? killedKey : edgeKey(t.from, t.to, t.reason);
      const row = declared.get(key);
      if (!row || (isKilled && !LIVE_STATES.has(t.from))) {
        failures.push(
          `UNDECLARED EDGE ${edgeKey(t.from, t.to, t.reason)} fired in "${scenario.name}" `
          + '— the machine took an edge not in the table.',
        );
        continue;
      }
      if (isKilled && row.observedFroms && !row.observedFroms.includes(t.from)) {
        row.observedFroms.push(t.from);
      }
      if (row.firedBy === null) {
        row.firedBy = scenario.name;
        row.tick = t.tick;
        row.time = +t.time.toFixed(3);
      }
    }
  }

  const rows = [...declared.values()];
  for (const row of rows) {
    if (row.firedBy === null) {
      failures.push(
        `UNREACHABLE EDGE ${edgeKey(row.from, row.to, row.reason)} never fired in any scenario.`,
      );
    }
  }

  return { ok: failures.length === 0, failures, rows, scenarioLog };
}

// ── Line-of-sight ───────────────────────────────────────────────────────────

interface LosCase {
  name: string;
  kind: 'los' | 'perception';
  expected: boolean;
  actual: boolean;
  detail: string;
}

function boxWorld(id: string, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): StaticWorld {
  return {
    boxes: [{
      id,
      min: { x: cx - hx, y: cy - hy, z: cz - hz },
      max: { x: cx + hx, y: cy + hy, z: cz + hz },
    }],
  };
}

function runLineOfSight(): { ok: boolean; failures: string[]; cases: LosCase[] } {
  const cases: LosCase[] = [];
  const emptyWorld: StaticWorld = { boxes: [] };
  const arena = buildArena();
  const c = DEFAULT_ENEMY_CONFIG;
  const eye = v3(0, c.eyeHeight, -6);
  const forwardZ = v3(0, 0, 1); // enemy facing +Z (yaw π)

  const push = (name: string, kind: LosCase['kind'], expected: boolean, actual: boolean, detail: string): void => {
    cases.push({ name, kind, expected, actual, detail });
  };

  // Pure LOS (occlusion only), no cone/range.
  push('clear-empty-world', 'los', true,
    lineOfSightClear(emptyWorld, v3(0, 1, 0), v3(0, 1, 10)),
    'no geometry between two points');
  push('blocked-box-on-segment', 'los', false,
    lineOfSightClear(boxWorld('b', 0, 1, 5, 1, 1, 1), v3(0, 1, 0), v3(0, 1, 10)),
    'a box straddling the mid-point blocks the line');
  push('clear-box-beside-segment', 'los', true,
    lineOfSightClear(boxWorld('b', 5, 1, 5, 1, 1, 1), v3(0, 1, 0), v3(0, 1, 10)),
    'a box 5 m to the side does not block the line');

  // Arena occlusion.
  push('arena-open-lane', 'los', true,
    lineOfSightClear(arena.world, eye, v3(0, c.targetSampleHeight, 1)),
    'enemy eye to a player on the open central lane');
  push('arena-behind-hide-l', 'los', false,
    lineOfSightClear(arena.world, eye, v3(-2.6, c.targetSampleHeight, 2.4)),
    'player tucked behind the hide-l block is NOT visible');
  push('arena-behind-pillar', 'los', false,
    lineOfSightClear(arena.world, eye, v3(0, c.targetSampleHeight, 6)),
    'player behind the central pillar (beyond z=4.2) is NOT visible');

  // Full perception: range + cone + occlusion together.
  const sight = { visionDistance: c.visionDistance, visionHalfAngleRadians: c.visionHalfAngleRadians };
  push('perceive-front-in-range', 'perception', true,
    canSee(v3(0, c.eyeHeight, 0), forwardZ, v3(0, c.targetSampleHeight, 6), emptyWorld, sight),
    'target ahead, in range and in the cone, unobstructed');
  push('perceive-behind-out-of-cone', 'perception', false,
    canSee(v3(0, c.eyeHeight, 0), forwardZ, v3(0, c.targetSampleHeight, -6), emptyWorld, sight),
    'target directly behind is outside the 120° cone');
  push('perceive-too-far', 'perception', false,
    canSee(v3(0, c.eyeHeight, 0), forwardZ, v3(0, c.targetSampleHeight, c.visionDistance + 4), emptyWorld, sight),
    'target beyond vision distance is not seen');
  push('perceive-occluded-in-cone', 'perception', false,
    canSee(v3(0, c.eyeHeight, 0), forwardZ, v3(0, c.targetSampleHeight, 10),
      boxWorld('b', 0, 1, 5, 1.5, 1.5, 1), sight),
    'target ahead and in range but behind a box is not seen');

  const failures = cases
    .filter((x) => x.expected !== x.actual)
    .map((x) => `LOS case "${x.name}" expected ${x.expected} but got ${x.actual}: ${x.detail}`);
  return { ok: failures.length === 0, failures, cases };
}

// ── Determinism ─────────────────────────────────────────────────────────────

/** A rich scenario that reaches engage, fires, reposition, search and reacquire. */
function determinismScenario(): Scenario {
  const keys: Key[] = [
    { t: 0, x: 0, z: 8.5 },
    { t: 3, x: 0, z: 1.2 },
    { t: 6, x: 0, z: 1.2 },
    { t: 6.9, x: -2.6, z: 2.4 },
    { t: 9.5, x: -2.6, z: 2.4 },
    { t: 10.5, x: 0, z: 1.2 },
    { t: 16, x: 0, z: 1.2 },
  ];
  return {
    name: 'determinism',
    note: 'engage → fire → reposition → search → reacquire, with aim scatter',
    seconds: 16,
    script: ({ time }) => ({ target: target(pathAt(keys, time)) }),
  };
}

function digest(result: SimResult): unknown {
  return {
    transitions: result.transitions.map((t) => ({
      from: t.from, to: t.to, reason: t.reason, tick: t.tick, time: +t.time.toFixed(6),
    })),
    snapshot: result.agent.snapshot(),
    fireLog: result.agent.fireLog.map((s) => ({
      t: +s.time.toFixed(6),
      i: s.burstIndex,
      err: +s.aimError.toFixed(9),
      dx: +s.direction.x.toFixed(9),
      dy: +s.direction.y.toFixed(9),
      dz: +s.direction.z.toFixed(9),
    })),
  };
}

function runDeterminism(): {
  ok: boolean;
  failures: string[];
  runs: number;
  shotsFired: number;
  transitions: number;
  identical: boolean;
} {
  const scenario = determinismScenario();
  const a = digest(runScenario(scenario));
  const b = digest(runScenario(scenario));
  const identical = JSON.stringify(a) === JSON.stringify(b);
  const failures = identical ? [] : ['determinism: two runs with the same seed and inputs differed'];
  const sample = runScenario(scenario);
  return {
    ok: identical,
    failures,
    runs: 2,
    shotsFired: sample.agent.shotsFired,
    transitions: sample.transitions.length,
    identical,
  };
}

// ── Render-rate independence ─────────────────────────────────────────────────

/**
 * Drive TARGET_STEPS fixed steps through an accumulator fed at various frame
 * rates. The per-step input is keyed to the STEP index, so every schedule feeds
 * identical inputs to identical steps; only the timing of when the steps run
 * differs. If behaviour depends only on the fixed step (as it must), the final
 * state is identical for every frame rate.
 */
function runRenderRate(): {
  ok: boolean;
  failures: string[];
  targetSteps: number;
  rates: number[];
  identical: boolean;
  transitions: number;
} {
  const arena = buildArena();
  const config = makeConfig();
  const keys: Key[] = [
    { t: 0, x: 0, z: 8.5 },
    { t: 3, x: 0, z: 1.2 },
    { t: 6, x: 0, z: 1.2 },
    { t: 6.9, x: -2.6, z: 2.4 },
    { t: 9.5, x: -2.6, z: 2.4 },
    { t: 10.5, x: 0, z: 1.2 },
    { t: 16, x: 0, z: 1.2 },
  ];
  const inputForStep = (stepIndex: number): StepInput => ({
    target: target(pathAt(keys, stepIndex * STEP)),
  });

  const TARGET_STEPS = Math.round(15 / STEP);
  const rates = [30, 60, 144, 240];
  const MAX_STEPS_PER_FRAME = 8; // mirror engine.ts

  const digests = rates.map((fps) => {
    const agent = new EnemyAgent(config, arena.world, arena.cover, arena.halfExtent, {
      spawn: ARENA_ENEMY_SPAWN,
      yaw: ARENA_ENEMY_YAW,
    });
    let accumulator = 0;
    const frameDt = 1 / fps;
    while (agent.tick < TARGET_STEPS) {
      accumulator += frameDt;
      let stepsThisFrame = 0;
      while (accumulator >= STEP && stepsThisFrame < MAX_STEPS_PER_FRAME && agent.tick < TARGET_STEPS) {
        agent.fixedStep(STEP, inputForStep(agent.tick + 1));
        accumulator -= STEP;
        stepsThisFrame++;
      }
      // If the frame's budget of steps ran out with the accumulator still full
      // (only at pathological low fps), drain it so progress is guaranteed.
      if (stepsThisFrame === MAX_STEPS_PER_FRAME) accumulator = 0;
    }
    return JSON.stringify({
      snapshot: agent.snapshot(),
      transitions: agent.transitions.map((t) => `${t.from}>${t.to}>${t.reason}@${t.tick}`),
    });
  });

  const identical = digests.every((d) => d === digests[0]);
  const failures = identical ? [] : ['render-rate: schedules diverged for identical fixed-step inputs'];
  const transitions = JSON.parse(digests[0]).transitions.length as number;
  return { ok: identical, failures, targetSteps: TARGET_STEPS, rates, identical, transitions };
}

// ── CPU cost ─────────────────────────────────────────────────────────────────

/**
 * Worst-of-three per-step cost for one enemy under a demanding load: continuous
 * engagement with firing and periodic repositioning. A warm-up run is discarded
 * before timing so the JIT is settled.
 */
function runCpu(): {
  ok: boolean;
  failures: string[];
  enemies: number;
  stepsPerTrial: number;
  trials: number;
  perStepMicros: number;
  perFrame60Micros: number;
  budgetMicros: number;
} {
  const arena = buildArena();
  const config = makeConfig();
  const keys: Key[] = [
    { t: 0, x: 0, z: 8.5 },
    { t: 3, x: 0, z: 1.2 },
    { t: 30, x: 0, z: 1.2 },
  ];

  const drive = (steps: number): void => {
    const agent = new EnemyAgent(config, arena.world, arena.cover, arena.halfExtent, {
      spawn: ARENA_ENEMY_SPAWN,
      yaw: ARENA_ENEMY_YAW,
    });
    for (let i = 0; i < steps; i++) {
      const time = (i + 1) * STEP;
      // Keep the player visible so the enemy stays in the expensive engage/fire
      // path; add a periodic damage pulse to exercise reposition selection.
      const damage = (i % 720 === 360) ? [{ amount: 4, sourcePosition: v3(0, 0, 3) }] : undefined;
      agent.fixedStep(STEP, { target: target(pathAt(keys, time)), damage });
    }
  };

  const stepsPerTrial = Math.round(45 / STEP); // 45 s of simulation per trial
  drive(2000); // warm-up, discarded

  const trials = 3;
  let worstPerStepMicros = 0;
  for (let t = 0; t < trials; t++) {
    const start = now();
    drive(stepsPerTrial);
    const elapsedMs = now() - start;
    const perStepMicros = (elapsedMs * 1000) / stepsPerTrial;
    if (perStepMicros > worstPerStepMicros) worstPerStepMicros = perStepMicros;
  }

  const perStepMicros = +worstPerStepMicros.toFixed(4);
  // The engine runs the 120 Hz fixed step; at 60 fps that is 2 steps per frame.
  const perFrame60Micros = +(perStepMicros * 2).toFixed(4);
  const budgetMicros = 250;
  const ok = perFrame60Micros < budgetMicros;
  const failures = ok ? [] : [
    `cpu: ${perFrame60Micros}µs/frame for 1 enemy exceeds the ${budgetMicros}µs budget`,
  ];
  return {
    ok,
    failures,
    enemies: 1,
    stepsPerTrial,
    trials,
    perStepMicros,
    perFrame60Micros,
    budgetMicros,
  };
}

function now(): number {
  const g = globalThis as { performance?: { now(): number } };
  if (g.performance && typeof g.performance.now === 'function') return g.performance.now();
  return Date.now();
}

// ── Top-level report ─────────────────────────────────────────────────────────

export interface EvidenceReport {
  ok: boolean;
  at: string;
  fixedStepHz: number;
  failures: string[];
  reachability: ReachabilityReport;
  lineOfSight: ReturnType<typeof runLineOfSight>;
  determinism: ReturnType<typeof runDeterminism>;
  renderRate: ReturnType<typeof runRenderRate>;
  cpu: ReturnType<typeof runCpu>;
}

export function buildReport(): EvidenceReport {
  const reachability = runReachability();
  const lineOfSight = runLineOfSight();
  const determinism = runDeterminism();
  const renderRate = runRenderRate();
  const cpu = runCpu();
  const failures = [
    ...reachability.failures,
    ...lineOfSight.failures,
    ...determinism.failures,
    ...renderRate.failures,
    ...cpu.failures,
  ];
  return {
    ok: failures.length === 0,
    at: new Date().toISOString(),
    fixedStepHz: Math.round(1 / STEP),
    failures,
    reachability,
    lineOfSight,
    determinism,
    renderRate,
    cpu,
  };
}
