/**
 * Deterministic, browser-free proof for the campaign library.
 *
 * Every case is pure logic over the real modules — no renderer, no DOM, no
 * network. The runner (`run-campaign.mjs`) compiles this with the project's own
 * TypeScript and executes it in plain Node, then archives `buildReport()` to
 * `evidence/report.json`. A reviewer reproduces every claim with:
 *
 *   node src/campaign/test/run-campaign.mjs
 *
 * Coverage (one section per contract promise):
 *   default state · deep link locked/unlocked/unknown + URL normalization ·
 *   elimination progression · death → checkpoint retry · final completion +
 *   post-finale replay/deploy invariant + final reload identity · persistence
 *   hydration/malformed/version-mismatch/migration · two spawn slots (mission 1
 *   derived + validated) · objective title + HUD snapshot fields · and negative
 *   controls for every catalog rejection.
 *
 * The shipping surface is generic: only the reviewed **Cargo Breach** adapter is
 * exported. To exercise multi-mission logic today the suite composes a catalog
 * from `cargoBreach` plus two obviously-synthetic `fixture-*` missions
 * (`./fixtures.js`); integration wires the real Relay/Foundry missions later.
 */

import {
  buildCampaignSnapshot,
  CampaignEvents,
  CampaignRuntime,
  CampaignValidationError,
  CAMPAIGN_SCHEMA_VERSION,
  CAMPAIGN_SNAPSHOT_VERSION,
  cargoBreach,
  cargoBreachDerivedSpawn,
  createCampaignCatalog,
  createInMemoryPersistence,
  DEFAULT_PERSISTENCE_KEY,
  defaultMissionId,
  eliminateEnemy,
  evaluateClearance,
  initialProgressState,
  InMemoryNavigation,
  isSpawnClear,
  parseCampaignSave,
  replayMission,
  resolveDeepLink,
  standsOnFloor,
  startMission,
  asMissionId,
} from '../index.js';
import type {
  CampaignCatalog,
  CampaignEvent,
  CampaignValidationCode,
  MissionDefinition,
} from '../index.js';
import { fixtureBravo, fixtureCharlie } from './fixtures.js';

// ── Tiny assertion harness ──────────────────────────────────────────────────

interface Outcome {
  name: string;
  pass: boolean;
  failures: string[];
  detail?: Record<string, unknown>;
}

const fmt = (v: unknown): string => JSON.stringify(v);

class Check {
  readonly failures: string[] = [];
  ok(cond: boolean, msg: string): void {
    if (!cond) this.failures.push(msg);
  }
  eq(actual: unknown, expected: unknown, msg: string): void {
    if (actual !== expected) this.failures.push(`${msg}: ${fmt(actual)} !== ${fmt(expected)}`);
  }
  deep(actual: unknown, expected: unknown, msg: string): void {
    const a = fmt(actual);
    const e = fmt(expected);
    if (a !== e) this.failures.push(`${msg}: ${a} !== ${e}`);
  }
  throwsCode(fn: () => unknown, code: CampaignValidationCode, msg: string): void {
    try {
      fn();
      this.failures.push(`${msg}: expected CampaignValidationError(${code}), nothing thrown`);
    } catch (err) {
      if (err instanceof CampaignValidationError) {
        if (err.code !== code) this.failures.push(`${msg}: code "${err.code}" !== "${code}"`);
      } else {
        this.failures.push(`${msg}: threw non-validation error: ${(err as Error).message}`);
      }
    }
  }
  throws(fn: () => unknown, msg: string): void {
    try {
      fn();
      this.failures.push(`${msg}: expected a throw, none happened`);
    } catch {
      /* expected */
    }
  }
}

type Body = (c: Check) => Record<string, unknown>;

function testCase(name: string, body: Body): Outcome {
  const c = new Check();
  let detail: Record<string, unknown> | undefined;
  try {
    detail = body(c);
  } catch (err) {
    c.failures.push(`unexpected throw: ${(err as Error).message}`);
  }
  return { name, pass: c.failures.length === 0, failures: c.failures, detail };
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

const CATALOG: CampaignCatalog = createCampaignCatalog([cargoBreach, fixtureBravo, fixtureCharlie]);
const M1 = cargoBreach.id;
const M2 = fixtureBravo.id;
const M3 = fixtureCharlie.id;

function mutate(base: MissionDefinition, patch: Record<string, unknown>): MissionDefinition {
  return { ...base, ...patch } as unknown as MissionDefinition;
}

function freshRuntime(options?: { requested?: string | null }): {
  runtime: CampaignRuntime;
  events: CampaignEvent[];
  navigation: InMemoryNavigation;
} {
  const { adapter } = createInMemoryPersistence();
  const navigation = new InMemoryNavigation(options?.requested ?? null);
  const events: CampaignEvent[] = [];
  const runtime = CampaignRuntime.create({
    catalog: CATALOG,
    persistence: adapter,
    navigation,
    emit: (e) => events.push(e),
  });
  return { runtime, events, navigation };
}

function eventTypes(events: readonly CampaignEvent[]): string[] {
  return events.map((e) => e.type);
}

// ── Cases ────────────────────────────────────────────────────────────────────

function testCatalogAcceptsDefault(): Outcome {
  return testCase('catalogAcceptsComposedCampaign', (c) => {
    c.eq(CATALOG.count, 3, 'composed campaign has three missions');
    c.deep(CATALOG.ids, [M1, M2, M3], 'ids are ordered 1..3');
    c.eq(CATALOG.firstMissionId, M1, 'first mission is cargo-breach');
    c.eq(CATALOG.nextMissionId(M1), M2, 'next after m1 is m2');
    c.eq(CATALOG.nextMissionId(M3), null, 'no mission after the finale');
    c.eq(CATALOG.previousMissionId(M1), null, 'no mission before m1');
    // The single reviewed mission is a valid one-mission catalog on its own.
    const solo = createCampaignCatalog([cargoBreach]);
    c.eq(solo.count, 1, 'cargo-breach alone is a valid catalog');
    c.eq(solo.firstMissionId, M1, 'solo catalog first mission is cargo-breach');
    return { ids: CATALOG.ids };
  });
}

function testDefaultState(): Outcome {
  return testCase('defaultFreshState', (c) => {
    const { runtime, events } = freshRuntime();
    const snap = runtime.snapshot();
    c.eq(snap.currentMissionId, M1, 'mission 1 is current on a fresh campaign');
    c.eq(snap.missions[0].status, 'current', 'm1 status current');
    c.eq(snap.missions[1].status, 'locked', 'm2 locked');
    c.eq(snap.missions[2].status, 'locked', 'm3 locked');
    c.eq(snap.campaignComplete, false, 'campaign not complete');
    c.eq(snap.completedCount, 0, 'nothing completed');
    c.eq(runtime.hydration.status, 'fresh', 'hydration is fresh with no save');
    c.eq(runtime.deepLink.outcome, 'absent', 'no deep link ⇒ absent');
    c.deep(eventTypes(events), [CampaignEvents.DeepLinkResolved], 'only a deep-link-resolved event on boot');
    return { snapshot: snap };
  });
}

function testDeepLinkResolverStates(): Outcome {
  return testCase('deepLinkLockedUnlockedUnknown', (c) => {
    const s0 = initialProgressState(CATALOG);
    // Locked: a future mission on a fresh campaign.
    const lockedFinal = resolveDeepLink(CATALOG, s0, M3);
    c.eq(lockedFinal.outcome, 'locked', 'm3 deep link is locked on a fresh campaign');
    if (lockedFinal.outcome === 'locked') c.eq(lockedFinal.blockedBy, M2, 'm3 is blocked by m2');
    const lockedMid = resolveDeepLink(CATALOG, s0, M2);
    c.eq(lockedMid.outcome, 'locked', 'm2 deep link is locked on a fresh campaign');
    if (lockedMid.outcome === 'locked') c.eq(lockedMid.blockedBy, M1, 'm2 is blocked by m1');

    // Resolved: the current mission.
    const cur = resolveDeepLink(CATALOG, s0, M1);
    c.eq(cur.outcome, 'resolved', 'm1 deep link resolves');

    // Unknown: malformed and unmapped ids.
    c.eq(resolveDeepLink(CATALOG, s0, 'ghost-mission').outcome, 'unknown', 'unmapped id ⇒ unknown');
    c.eq(resolveDeepLink(CATALOG, s0, 'Bad Id').outcome, 'unknown', 'malformed id ⇒ unknown');
    c.eq(resolveDeepLink(CATALOG, s0, '').outcome, 'absent', 'empty ⇒ absent');
    c.eq(resolveDeepLink(CATALOG, s0, null).outcome, 'absent', 'null ⇒ absent');

    // Unlocked-but-not-current: complete m1 then replay m1 so m2 is 'unlocked'.
    const afterM1 = eliminateEnemy(s0, CATALOG).state; // m1 done, m2 current
    const backOnM1 = replayMission(afterM1, CATALOG, M1).state; // m1 current, m2 unlocked
    c.eq(backOnM1.records[M2].status, 'unlocked', 'm2 is unlocked but not current');
    const unlocked = resolveDeepLink(CATALOG, backOnM1, M2);
    c.eq(unlocked.outcome, 'resolved', 'an unlocked mission deep link resolves');
    if (unlocked.outcome === 'resolved') c.eq(unlocked.status, 'unlocked', 'resolution carries the unlocked status');
    return { lockedFinal, unlocked };
  });
}

function testDeepLinkNeverForgesCompletion(): Outcome {
  return testCase('deepLinkNoSuccessFallback', (c) => {
    // A locked deep link must report, not deploy or forge.
    const locked = freshRuntime({ requested: M3 });
    c.eq(locked.runtime.deepLink.outcome, 'locked', 'locked deep link reported as locked');
    const snap = locked.runtime.snapshot();
    c.eq(snap.currentMissionId, M1, 'locked deep link leaves the player at the frontier');
    c.eq(snap.completedCount, 0, 'locked deep link forged no completion');
    c.eq(snap.campaignComplete, false, 'campaign is not falsely complete');
    c.ok(!locked.runtime.progressState.completedOrder.includes(M3), 'm3 was not marked completed');

    // An unknown deep link likewise.
    const unknown = freshRuntime({ requested: 'ghost-mission' });
    c.eq(unknown.runtime.deepLink.outcome, 'unknown', 'unknown deep link reported as unknown');
    c.eq(unknown.runtime.snapshot().currentMissionId, M1, 'unknown deep link keeps the default');
    c.eq(unknown.runtime.snapshot().completedCount, 0, 'unknown deep link forged no completion');
    return { locked: locked.runtime.deepLink, unknown: unknown.runtime.deepLink };
  });
}

function testDeepLinkResolvedDeploys(): Outcome {
  return testCase('deepLinkResolvedDeploys', (c) => {
    // Seed persistence: complete m1 so m2 is the available frontier.
    const persistence = createInMemoryPersistence();
    const runA = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: persistence.adapter,
      navigation: new InMemoryNavigation(),
    });
    runA.reportElimination(); // m1 done → m2 current, persisted

    // A new runtime with a deep link to m2 resolves and deploys into it.
    const events: CampaignEvent[] = [];
    const nav = new InMemoryNavigation(M2);
    const runB = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: persistence.adapter,
      navigation: nav,
      emit: (e) => events.push(e),
    });
    c.eq(runB.deepLink.outcome, 'resolved', 'deep link to available mission resolves');
    c.eq(runB.snapshot().currentMissionId, M2, 'runtime deploys into the resolved mission');
    c.eq(runB.hydration.status, 'restored', 'progress restored from the seeded save');
    c.eq(nav.reloadRequests.length, 0, 'resolving a deep link never triggers a reload');
    return { deepLink: runB.deepLink, current: runB.snapshot().currentMissionId };
  });
}

function testEliminationProgression(): Outcome {
  return testCase('eliminationProgression', (c) => {
    const { runtime, events } = freshRuntime();
    runtime.reportElimination(); // m1 (1 enemy) → complete
    let snap = runtime.snapshot();
    c.eq(snap.missions[0].status, 'completed', 'm1 completed after its lone defender falls');
    c.eq(snap.missions[1].status, 'current', 'm2 becomes current');
    c.eq(snap.currentMissionId, M2, 'pointer advanced to m2');

    // m2 has two defenders: one elimination must NOT complete it.
    runtime.reportElimination();
    snap = runtime.snapshot();
    c.eq(snap.missions[1].status, 'current', 'm2 still current after one of two');
    c.eq(snap.eliminations?.current, 1, 'one of two eliminations banked');
    c.eq(snap.eliminations?.remaining, 1, 'one defender remaining');
    runtime.reportElimination();
    snap = runtime.snapshot();
    c.eq(snap.missions[1].status, 'completed', 'm2 completed after the second defender');
    c.eq(snap.missions[2].status, 'current', 'm3 unlocked and current');

    const types = eventTypes(events);
    c.ok(types.includes(CampaignEvents.MissionCompleted), 'a mission-completed event fired');
    c.ok(types.includes(CampaignEvents.MissionUnlocked), 'a mission-unlocked event fired');
    return { events: types };
  });
}

function testDeathRetryCheckpoint(): Outcome {
  return testCase('deathRetryCheckpoint', (c) => {
    const { runtime, events } = freshRuntime();
    runtime.reportElimination(); // finish m1 → m2 current

    // m2 banks on elimination and retries from the last checkpoint.
    runtime.reportElimination(); // first of two on m2, banked
    c.eq(runtime.progressState.activeEliminations, 1, 'm2 has one banked elimination');
    c.eq(runtime.progressState.records[M2].bankedEliminations, 1, 'checkpoint banked at 1');
    runtime.reportPlayerDeath();
    c.eq(runtime.progressState.activeEliminations, 1, 'death resumes from the banked checkpoint, not zero');
    c.eq(runtime.snapshot().missions[1].status, 'current', 'm2 stays current after death');
    c.ok(!runtime.progressState.completedOrder.includes(M2), 'death did not complete m2');

    // Finish m2, advance to m3 (mission-start retry, no banking).
    runtime.reportElimination(); // second on m2 → complete, m3 current
    c.eq(runtime.snapshot().currentMissionId, M3, 'advanced to the finale');
    runtime.reportElimination(); // first of two on m3, NOT banked
    c.eq(runtime.progressState.records[M3].bankedEliminations, 0, 'm3 does not bank on elimination');
    runtime.reportPlayerDeath();
    c.eq(runtime.progressState.activeEliminations, 0, 'mission-start retry wipes progress to zero');

    const types = eventTypes(events);
    c.ok(types.includes(CampaignEvents.CheckpointBanked), 'a checkpoint-banked event fired for m2');
    c.ok(types.includes(CampaignEvents.MissionFailed), 'a mission-failed event fired');
    return { events: types };
  });
}

function testFinalCompletion(): Outcome {
  return testCase('finalCompletionCompletesCampaign', (c) => {
    const { runtime, events } = freshRuntime();
    runtime.reportElimination(); // m1
    runtime.reportElimination(); // m2 #1
    runtime.reportElimination(); // m2 #2 → complete
    runtime.reportElimination(); // m3 #1
    runtime.reportElimination(); // m3 #2 → complete → campaign complete

    const snap = runtime.snapshot();
    c.eq(snap.campaignComplete, true, 'campaign is complete after the finale');
    c.eq(snap.currentMissionId, null, 'no current mission once complete');
    c.eq(snap.completedCount, 3, 'all three missions completed');
    c.deep(runtime.progressState.completedOrder, [M1, M2, M3], 'completion order preserved');
    c.ok(eventTypes(events).includes(CampaignEvents.CampaignCompleted), 'a campaign-completed event fired');
    return { completedOrder: runtime.progressState.completedOrder };
  });
}

function testDeterministicReplayOfCampaign(): Outcome {
  return testCase('deterministicEventSequence', (c) => {
    const run = (): string[] => {
      const { runtime, events } = freshRuntime();
      for (let i = 0; i < 5; i++) runtime.reportElimination();
      return eventTypes(events);
    };
    const a = run();
    const b = run();
    c.deep(a, b, 'two identical runs emit an identical event sequence');
    return { sequence: a };
  });
}

function testPersistenceHydration(): Outcome {
  return testCase('persistenceHydrationRoundTrip', (c) => {
    const persistence = createInMemoryPersistence();
    const runA = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: persistence.adapter,
      navigation: new InMemoryNavigation(),
    });
    runA.reportElimination(); // m1 done → m2 current, persisted
    runA.reportElimination(); // m2 #1 banked

    const runB = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: persistence.adapter,
      navigation: new InMemoryNavigation(),
    });
    c.eq(runB.hydration.status, 'restored', 'save restores rather than starting fresh');
    c.eq(runB.snapshot().currentMissionId, M2, 'restored current mission is m2');
    c.eq(runB.progressState.records[M1].status, 'completed', 'm1 remains completed after reload');
    c.eq(runB.progressState.records[M2].bankedEliminations, 1, 'banked checkpoint survived reload');
    c.deep(
      buildCampaignSnapshot(CATALOG, runB.progressState),
      runA.snapshot(),
      'hydrated snapshot equals the persisted one',
    );
    return { restored: runB.snapshot() };
  });
}

function testPersistenceMalformed(): Outcome {
  return testCase('persistenceMalformedRefused', (c) => {
    c.eq(parseCampaignSave('not json {').status, 'malformed', 'non-JSON is malformed');
    c.eq(parseCampaignSave('42').status, 'malformed', 'a bare number is malformed');
    c.eq(parseCampaignSave('{"schemaVersion":2}').status, 'malformed', 'missing progress is malformed');
    c.eq(
      parseCampaignSave(`{"schemaVersion":${CAMPAIGN_SCHEMA_VERSION},"progress":{}}`).status,
      'malformed',
      'empty progress fails shape validation',
    );

    // A malformed save drives the runtime to a clean fresh start, never a forge.
    const { adapter, store } = createInMemoryPersistence();
    store.setItem(DEFAULT_PERSISTENCE_KEY, 'not json {');
    const runtime = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: adapter,
      navigation: new InMemoryNavigation(),
    });
    c.eq(runtime.hydration.status, 'refused', 'malformed save refused');
    c.eq(runtime.snapshot().currentMissionId, M1, 'refusal degrades to a fresh campaign');
    c.eq(runtime.snapshot().completedCount, 0, 'refused save forged no completion');
    return { hydration: runtime.hydration };
  });
}

function testPersistenceVersionMismatch(): Outcome {
  return testCase('persistenceVersionMismatchAndMigration', (c) => {
    // A save from a newer build is refused, not silently reinterpreted.
    const future = `{"schemaVersion":${CAMPAIGN_SCHEMA_VERSION + 1},"progress":{}}`;
    c.eq(parseCampaignSave(future).status, 'stale-version', 'a future schema version is refused');

    const { adapter, store } = createInMemoryPersistence();
    store.setItem(DEFAULT_PERSISTENCE_KEY, future);
    const refused = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: adapter,
      navigation: new InMemoryNavigation(),
    });
    c.eq(refused.hydration.status, 'refused', 'runtime refuses a future-version save');
    c.eq(refused.snapshot().currentMissionId, M1, 'refusal degrades to fresh');

    // A known older (v1) save migrates up and restores.
    const v1 = JSON.stringify({
      schemaVersion: 1,
      progress: {
        currentMissionId: M2,
        records: {
          [M1]: { status: 'completed' },
          [M2]: { status: 'current' },
          [M3]: { status: 'locked' },
        },
        completedOrder: [M1],
        campaignComplete: false,
      },
    });
    const migratedRead = parseCampaignSave(v1);
    c.eq(migratedRead.status, 'migrated', 'a v1 save is migrated');
    c.eq(migratedRead.data?.progress.activeEliminations, 0, 'migration defaults the live counter');
    c.eq(
      migratedRead.data?.progress.records[M2].bankedEliminations,
      0,
      'migration defaults per-mission checkpoints',
    );

    const migPersistence = createInMemoryPersistence();
    migPersistence.store.setItem(DEFAULT_PERSISTENCE_KEY, v1);
    const migRuntime = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: migPersistence.adapter,
      navigation: new InMemoryNavigation(),
    });
    c.eq(migRuntime.hydration.status, 'migrated', 'runtime reports a migrated hydration');
    c.eq(migRuntime.snapshot().currentMissionId, M2, 'migrated save restores the current mission');

    // A save whose mission ids do not match this catalog is refused.
    const alien = JSON.stringify({
      schemaVersion: CAMPAIGN_SCHEMA_VERSION,
      progress: {
        currentMissionId: 'other-mission',
        activeEliminations: 0,
        records: { 'other-mission': { status: 'current', bankedEliminations: 0 } },
        completedOrder: [],
        campaignComplete: false,
      },
    });
    const alienPersistence = createInMemoryPersistence();
    alienPersistence.store.setItem(DEFAULT_PERSISTENCE_KEY, alien);
    const alienRuntime = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: alienPersistence.adapter,
      navigation: new InMemoryNavigation(),
    });
    c.eq(alienRuntime.hydration.status, 'refused', 'a catalog-mismatched save is refused');
    return { migratedRead: migratedRead.status };
  });
}

function testTwoSpawnSlots(): Outcome {
  return testCase('twoFloorSpawnSlotsValidated', (c) => {
    for (const mission of CATALOG.missions) {
      const arena = CATALOG.arenaFor(mission.id);
      c.eq(mission.playerSpawns.length, 2, `${mission.id} declares two spawns`);
      for (const slot of mission.playerSpawns) {
        c.eq(slot.position[1], 0, `${mission.id}/${slot.id} is floor-based (y=0)`);
        c.ok(standsOnFloor(slot.position, arena.solids), `${mission.id}/${slot.id} stands on a floor slab`);
        c.ok(isSpawnClear(slot.position, arena.solids), `${mission.id}/${slot.id} stands clear of solids`);
      }
    }

    // Mission 1's second spawn is derived from geometry, not typed in by hand.
    const arena = CATALOG.arenaFor(M1);
    c.ok(
      cargoBreachDerivedSpawn.method === 'preferred-offset' || cargoBreachDerivedSpawn.method === 'grid-scan',
      'the derived spawn came from a real search',
    );
    const primary = cargoBreach.playerSpawns[0].position;
    const secondary = cargoBreach.playerSpawns[1].position;
    c.deep(secondary, cargoBreachDerivedSpawn.position, 'mission 1 slot B is the derived point');
    c.ok(fmt(secondary) !== fmt(primary), 'the derived spawn differs from the primary');
    c.ok(isSpawnClear(secondary, arena.solids), 'the derived spawn is provably clear');
    const sep = Math.hypot(secondary[0] - primary[0], secondary[2] - primary[2]);
    c.ok(sep >= 2.5, `derived spawn keeps ${sep.toFixed(2)}m separation`);

    // Negative controls: an embedded point and an off-floor point are rejected.
    const insideContainer = evaluateClearance([-1.8, 0, -9.3], arena.solids);
    c.ok(!insideContainer.clear, 'a point inside a container is not clear');
    c.eq(insideContainer.blockingSolidId, 'cont-a', 'the blocking solid is identified');
    c.ok(!standsOnFloor([100, 0, 100], arena.solids), 'a point off the floor plate has no floor beneath it');
    return { derived: cargoBreachDerivedSpawn, separation: sep };
  });
}

function testCatalogNegativeControls(): Outcome {
  return testCase('catalogRejectsEveryFault', (c) => {
    const [d1, d2] = [cargoBreach, fixtureBravo];

    c.throwsCode(() => createCampaignCatalog([]), 'empty-catalog', 'empty catalog');
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, { id: 'Bad Id' })]),
      'malformed-id',
      'non-kebab id',
    );
    c.throwsCode(
      () => createCampaignCatalog([d1, mutate(d2, { id: d1.id })]),
      'duplicate-id',
      'duplicate id',
    );
    c.throwsCode(
      () => createCampaignCatalog([d1, mutate(d2, { order: 1 })]),
      'duplicate-order',
      'duplicate order',
    );
    c.throwsCode(
      () => createCampaignCatalog([d1, mutate(d2, { order: 3 })]),
      'non-contiguous-order',
      'gap in orders',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, { playerSpawns: [cargoBreach.playerSpawns[0]] })]),
      'insufficient-spawns',
      'fewer than two spawns',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        playerSpawns: [
          { ...cargoBreach.playerSpawns[0], position: [0, 5, -1.6] },
          cargoBreach.playerSpawns[1],
        ],
      })]),
      'spawn-not-floor',
      'a spawn off the floor',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        playerSpawns: [
          { ...cargoBreach.playerSpawns[0], position: [-1.8, 0, -9.3] },
          cargoBreach.playerSpawns[1],
        ],
      })]),
      'spawn-obstructed',
      'a spawn embedded in a container',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        playerSpawns: [cargoBreach.playerSpawns[0], cargoBreach.playerSpawns[0]],
      })]),
      'duplicate-spawn',
      'two identical spawns',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, { objective: { kind: 'eliminate', summary: '  ' } })]),
      'missing-objective',
      'blank objective summary',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, { objective: { kind: 'eliminate', title: '  ', summary: 'ok' } })]),
      'missing-objective',
      'blank objective title',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, { enemies: [] })]),
      'no-enemies',
      'no defenders',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        enemies: [{ id: 'e', spawn: [-9, 0, -13], yaw: 0, coverSolidIds: [] }],
      })]),
      'missing-cover',
      'a defender without cover',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        enemies: [{ id: 'e', spawn: [-9, 0, -13], yaw: 0, coverSolidIds: ['lamp-w'] }],
      })]),
      'cover-not-collidable',
      'cover pointing at non-colliding dressing',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        enemies: [{ id: 'e', spawn: [-9, 0, -13], yaw: 0, coverSolidIds: ['does-not-exist'] }],
      })]),
      'cover-not-collidable',
      'cover pointing at a missing solid',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        completion: { kind: 'eliminate-all-enemies', requiredEliminations: 5 },
      })]),
      'invalid-progression',
      'requiredEliminations beyond the defender count',
    );
    c.throwsCode(
      () => createCampaignCatalog([mutate(d1, {
        enemies: [{ id: 'e', spawn: [-1.8, 0, -9.3], yaw: 0, coverSolidIds: ['cont-a'] }],
      })]),
      'enemy-embedded',
      'a defender embedded in a solid',
    );
    return { controls: 18 };
  });
}

function testProgressGuards(): Outcome {
  return testCase('progressMachineGuards', (c) => {
    const s0 = initialProgressState(CATALOG);
    c.throws(() => startMission(s0, CATALOG, M3), 'starting a locked mission throws');
    c.throws(() => startMission(s0, CATALOG, asMissionId('ghost')), 'starting an unknown mission throws');
    // Eliminating with no current mission (post-complete) throws.
    let s = s0;
    for (let i = 0; i < 5; i++) s = eliminateEnemy(s, CATALOG).state;
    c.eq(s.currentMissionId, null, 'campaign complete leaves no current mission');
    c.throws(() => eliminateEnemy(s, CATALOG), 'eliminating with no current mission throws');
    return {};
  });
}

// ── Report ──────────────────────────────────────────────────────────────────

function completedState() {
  let s = initialProgressState(CATALOG);
  for (let i = 0; i < 5; i++) s = eliminateEnemy(s, CATALOG).state;
  return s;
}

function testObjectiveTitleAndSnapshotFields(): Outcome {
  return testCase('objectiveTitleAndHudSnapshotFields', (c) => {
    // The reviewed mission carries the exact production HUD banner.
    c.eq(cargoBreach.objective.title, 'SECURE THE CARGO BAY', 'cargo objective title is the HUD banner');

    const { runtime } = freshRuntime();
    const snap = runtime.snapshot();
    c.eq(snap.snapshotVersion, CAMPAIGN_SNAPSHOT_VERSION, 'snapshot advertises its version');
    c.eq(CAMPAIGN_SNAPSHOT_VERSION, 2, 'snapshot version bumped for the new shape');
    c.eq(snap.currentObjectiveTitle, 'SECURE THE CARGO BAY', 'current objective title surfaced');
    c.eq(snap.missions[0].objectiveTitle, 'SECURE THE CARGO BAY', 'per-mission objective title surfaced');
    c.eq(snap.missionCount, 3, 'missionCount equals the catalog size');
    c.eq(snap.finaleMissionId, M3, 'finaleMissionId is the last mission');
    c.eq(snap.furthestUnlockedIndex, 0, 'only mission 1 is reachable on a fresh campaign');

    // furthestUnlockedIndex advances as missions unlock, monotonically.
    runtime.reportElimination(); // m1 done → m2 current/unlocked
    c.eq(runtime.snapshot().furthestUnlockedIndex, 1, 'index tracks the frontier after m1');
    runtime.reportElimination(); // m2 #1
    runtime.reportElimination(); // m2 #2 → m3 current
    c.eq(runtime.snapshot().furthestUnlockedIndex, 2, 'index reaches the finale');

    // After completion the finale identity is still exposed; objective title clears.
    runtime.reportElimination(); // m3 #1
    runtime.reportElimination(); // m3 #2 → complete
    const done = runtime.snapshot();
    c.eq(done.campaignComplete, true, 'campaign complete');
    c.eq(done.currentObjectiveTitle, null, 'no current objective once complete');
    c.eq(done.finaleMissionId, M3, 'finaleMissionId still exposed when complete');
    c.eq(done.furthestUnlockedIndex, 2, 'furthest index holds at the finale when complete');
    return { snapshot: done };
  });
}

function testPostFinaleReplayDeployInvariant(): Outcome {
  return testCase('postFinaleReplayDeployNeverCoexists', (c) => {
    // Pure reducers: starting/replaying from a completed state reopens it.
    const done = completedState();
    c.eq(done.campaignComplete, true, 'precondition: campaign is complete');
    c.eq(done.currentMissionId, null, 'precondition: no current mission');

    const afterStart = startMission(done, CATALOG, M1).state;
    c.eq(afterStart.campaignComplete, false, 'startMission clears campaignComplete');
    c.eq(afterStart.currentMissionId, M1, 'startMission sets the current mission');
    c.ok(!(afterStart.campaignComplete && afterStart.currentMissionId !== null), 'invariant holds after start');

    const afterReplay = replayMission(done, CATALOG, M3).state;
    c.eq(afterReplay.campaignComplete, false, 'replayMission clears campaignComplete');
    c.eq(afterReplay.currentMissionId, M3, 'replayMission sets the current mission');
    c.ok(!(afterReplay.campaignComplete && afterReplay.currentMissionId !== null), 'invariant holds after replay');

    // Runtime commands: deploy/replay after the finale reopen the campaign, and
    // never leave campaignComplete true alongside a current mission.
    const { runtime } = freshRuntime();
    for (let i = 0; i < 5; i++) runtime.reportElimination();
    c.eq(runtime.snapshot().campaignComplete, true, 'runtime reached completion');

    runtime.deploy(M1);
    let snap = runtime.snapshot();
    c.eq(snap.campaignComplete, false, 'deploy after finale reopens the campaign');
    c.eq(snap.currentMissionId, M1, 'deploy after finale sets a current mission');
    c.ok(!(snap.campaignComplete && snap.currentMissionId !== null), 'invariant holds after deploy');

    // Replaying the finale from the reopened campaign keeps the invariant.
    runtime.replay(M3);
    snap = runtime.snapshot();
    c.eq(snap.campaignComplete, false, 'replay after finale reopens the campaign');
    c.eq(snap.currentMissionId, M3, 'replay after finale sets a current mission');
    c.ok(!(snap.campaignComplete && snap.currentMissionId !== null), 'invariant holds after replay');
    return {};
  });
}

function testDeepLinkNormalization(): Outcome {
  return testCase('lockedAndUnknownDeepLinkNormalizeUrl', (c) => {
    // defaultMissionId is the frontier mid-campaign, the finale once complete.
    const fresh = initialProgressState(CATALOG);
    c.eq(defaultMissionId(CATALOG, fresh), M1, 'default is the frontier on a fresh campaign');
    c.eq(defaultMissionId(CATALOG, completedState()), M3, 'default is the finale once complete');

    // A locked deep link normalizes the URL to the current/default mission
    // without deploying into it or forging any completion.
    const locked = freshRuntime({ requested: M3 });
    c.eq(locked.runtime.deepLink.outcome, 'locked', 'locked link reported as locked');
    if (locked.runtime.deepLink.outcome === 'locked') {
      c.eq(locked.runtime.deepLink.fallbackMissionId, M1, 'locked link carries the frontier fallback');
    }
    c.eq(locked.navigation.readRequestedMissionId(), M1, 'locked URL normalized to the frontier');
    c.deep(locked.navigation.replacements, [M1], 'exactly one URL rewrite for a locked link');
    c.eq(locked.navigation.reloadRequests.length, 0, 'normalization never triggers a reload');
    c.eq(locked.runtime.snapshot().currentMissionId, M1, 'player stays at the frontier');
    c.eq(locked.runtime.snapshot().campaignComplete, false, 'locked link forged no completion');

    // An unknown deep link normalizes the same way.
    const unknown = freshRuntime({ requested: 'ghost-mission' });
    c.eq(unknown.runtime.deepLink.outcome, 'unknown', 'unknown link reported as unknown');
    c.eq(unknown.navigation.readRequestedMissionId(), M1, 'unknown URL normalized to the frontier');
    c.deep(unknown.navigation.replacements, [M1], 'exactly one URL rewrite for an unknown link');

    // An absent link is left untouched (nothing to normalize).
    const absent = freshRuntime();
    c.eq(absent.runtime.deepLink.outcome, 'absent', 'no link ⇒ absent');
    c.deep(absent.navigation.replacements, [], 'absent link performs no URL rewrite');
    return { locked: locked.runtime.deepLink, unknown: unknown.runtime.deepLink };
  });
}

function testFinalReloadIdentity(): Outcome {
  return testCase('finalReloadPreservesCompletion', (c) => {
    // Complete the campaign, persisting the finished state.
    const persistence = createInMemoryPersistence();
    const runA = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: persistence.adapter,
      navigation: new InMemoryNavigation(),
    });
    for (let i = 0; i < 5; i++) runA.reportElimination();
    c.eq(runA.snapshot().campaignComplete, true, 'run A completed the campaign');

    // Reload with the URL still pointing at the finale mission.
    const nav = new InMemoryNavigation(M3);
    const runB = CampaignRuntime.create({
      catalog: CATALOG,
      persistence: persistence.adapter,
      navigation: nav,
    });
    c.eq(runB.hydration.status, 'restored', 'completed save is restored on reload');
    c.eq(runB.snapshot().campaignComplete, true, 'reload stays complete — never un-completed');
    c.eq(runB.snapshot().currentMissionId, null, 'no current mission after a completed reload');
    c.ok(
      !(runB.snapshot().campaignComplete && runB.snapshot().currentMissionId !== null),
      'invariant holds across reload',
    );
    c.eq(runB.snapshot().finaleMissionId, M3, 'finale identity exposed after reload');
    c.eq(runB.deepLink.outcome, 'resolved', 'finale deep link resolves (mission is completed)');
    c.eq(nav.reloadRequests.length, 0, 'a completed reload triggers no navigation');
    c.deep(runB.progressState.completedOrder, [M1, M2, M3], 'completion order intact after reload');
    return { hydration: runB.hydration.status, complete: runB.snapshot().campaignComplete };
  });
}

export function runAllCampaignTests(): Outcome[] {
  return [
    testCatalogAcceptsDefault(),
    testDefaultState(),
    testDeepLinkResolverStates(),
    testDeepLinkNeverForgesCompletion(),
    testDeepLinkResolvedDeploys(),
    testEliminationProgression(),
    testDeathRetryCheckpoint(),
    testFinalCompletion(),
    testDeterministicReplayOfCampaign(),
    testPersistenceHydration(),
    testPersistenceMalformed(),
    testPersistenceVersionMismatch(),
    testTwoSpawnSlots(),
    testCatalogNegativeControls(),
    testProgressGuards(),
    testObjectiveTitleAndSnapshotFields(),
    testPostFinaleReplayDeployInvariant(),
    testDeepLinkNormalization(),
    testFinalReloadIdentity(),
  ];
}

export interface CampaignTestReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: string[];
  tests: Outcome[];
}

export function buildReport(): CampaignTestReport {
  const tests = runAllCampaignTests();
  const failed = tests.filter((t) => !t.pass);
  const failures: string[] = [];
  for (const t of failed) for (const f of t.failures) failures.push(`${t.name}: ${f}`);
  return {
    ok: failed.length === 0,
    total: tests.length,
    passed: tests.length - failed.length,
    failed: failed.length,
    failures,
    tests,
  };
}
