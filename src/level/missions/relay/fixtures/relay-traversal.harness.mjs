/**
 * RELAY BLACKOUT deploy→deck traversal harness (issue #72, parent #70).
 *
 * The correspondence proof shows render == collision; the topology proof shows
 * the mission is structurally distinct and its pads/objective are clear. Neither
 * says a HUMAN can actually WALK from a deploy pad, weave the switchyard and
 * stand on the relay control deck. This harness closes that gap with the only
 * witness that counts: the SHIPPING player motor.
 *
 * It builds the mission's REAL `StaticWorld` (`buildStaticWorld(buildRelayArena())`
 * — the exact boxes the game collides against), wraps it in the shipping
 * `StaticBoxWorld` solver and drives the shipping `PlayerMotor` (both from
 * `src/player`, PR #40) at the engine's 120 Hz fixed step. Unlike the single
 * straight-north cargo climb, each relay pad is OFFSET from the central stair
 * behind a transformer gate, so the drive is a deterministic WAYPOINT FOLLOWER:
 * ordinary WASD intent (compute yaw toward the next waypoint, hold "forward")
 * with NO teleport, NO `motor.position =`, NO free camera. West and east pads
 * take mirror lanes through the two switch-house throats, converge at the stair
 * base and climb head-on onto the deck, finishing at the relay objective.
 *
 * Climb targets are derived from the arena geometry itself (`deck`, `step-*`,
 * `objective`), and every authored waypoint is asserted to fit a standing
 * capsule BEFORE the drive, so the fixture fails loudly (not silently into a
 * wall) if a layout change invalidates the route.
 *
 * NON-VACUOUS: a negative control re-runs the west route against a world with
 * the `step-*` treads REMOVED and asserts the capsule can NOT reach the deck —
 * proving the treads are load-bearing and the success is real.
 *
 * Result published on `window.__RELAY_TRAVERSAL__` for the playwright runner.
 * `.mjs` on purpose: runtime glue, excluded from `tsc` (allowJs off), so the
 * committed level build stays clean while importing `src/player` at run time.
 */

import * as THREE from 'three';
import { buildRelayArena } from '../relayArena.js';
import { buildStaticWorld } from '../../../staticWorld.js';
import { PlayerMotor } from '../../../../player/PlayerMotor.js';
import { StaticBoxWorld } from '../../../../player/StaticBoxWorld.js';
import { DEFAULT_PLAYER_TUNING } from '../../../../player/config.js';

const out = window;
const STEP = 1 / 120;
const round = (v, d = 4) => { const s = 10 ** d; return Math.round(v * s) / s; };

try {
  const def = buildRelayArena();
  const world = buildStaticWorld(def);
  const tuning = DEFAULT_PLAYER_TUNING;

  const byId = (id) => def.solids.find((s) => s.id === id);
  // ── Climb targets derived from the REAL geometry (no hard-coded copy) ──────
  const deck = byId('deck');
  const steps = def.solids.filter((s) => s.id.startsWith('step-'));
  if (!deck) throw new Error('relay arena has no `deck` solid');
  if (steps.length === 0) throw new Error('relay arena has no `step-*` solids');
  const deckTop = deck.max[1];
  const deckXmin = deck.min[0];
  const deckXmax = deck.max[0];
  const deckZmin = deck.min[2];
  const deckZmax = deck.max[2];              // south (stair-facing) edge
  const deckInteriorZ = deckZmax - 0.6;      // past the south parapet depth
  const stairXCenter = (Math.min(...steps.map((s) => s.min[0]))
    + Math.max(...steps.map((s) => s.max[0]))) / 2;
  const stairSouthZ = Math.max(...steps.map((s) => s.max[2])); // southmost tread face

  const objective = def.objective;           // { position:[x,y,z] on the deck }
  const objZ = objective.position[2];

  // ── The two mission routes (mirror lanes through the switch-house throats) ──
  // Throat centres are derived from the switch-house and near-transformer faces
  // so a layout change moves the route with it (and the canFit gate below trips
  // if it ever stops fitting).
  const sh = byId('switchhouse');
  const e1 = byId('transformer-e1');
  const w1 = byId('transformer-w1');
  const throatE = round((sh.max[0] + e1.min[0]) / 2); // ~ +2.15  (east gap centre)
  const throatW = round((sh.min[0] + w1.max[0]) / 2);  // ~ -2.15  (west gap centre)

  const padA = def.playerSpawns[0].position;   // west  [-4.2,0,0.9]
  const padB = def.playerSpawns[1].position;   // east  [ 4.2,0,0.9]

  // Each route: pad → lane mouth → throat entry → past switch-house → recentre
  // on the stair axis → objective. XZ waypoints only; y is resolved by the
  // motor. Waypoints 0..3 are floor-level (canFit-gated below); the final
  // waypoint is the objective hold ON the raised deck (validated by the drive
  // actually reaching it, not by a feet-on-floor fit test).
  const routeFor = (pad, throatX) => [
    [throatX, pad[2] - 1.9],   // pull inward to the central lane mouth (south of the gate)
    [throatX, -3.4],           // throat entry, south of the switch-house
    [throatX, -6.9],           // through the throat, now north of the switch-house
    [stairXCenter, -8.4],      // recentre onto the stair axis, just south of the treads
    [stairXCenter, objZ],      // climb head-on and settle at the objective
  ];
  const routes = {
    'deploy-west': { pad: padA, waypoints: routeFor(padA, throatW) },
    'deploy-east': { pad: padB, waypoints: routeFor(padB, throatE) },
  };

  // ── Waypoint-following drive of the SHIPPING motor ────────────────────────
  const ARRIVE = 0.55; // horizontal arrival radius (m)
  const drive = (solver, spawnArr, waypoints, { settleAtEnd = true } = {}) => {
    const spawn = new THREE.Vector3(spawnArr[0], spawnArr[1], spawnArr[2]);
    const fits = solver.canFit(spawn, tuning.standingHeight, tuning.radius);
    const motor = new PlayerMotor(solver, spawn, tuning);

    const MAX_TICKS = 4000;
    const trajectory = [];
    let wp = 0;
    let reachedDeck = false;
    let reachedDeckTick = -1;
    let maxSteppedHeight = 0;
    let maxSingleTickRiseMm = 0;
    let airborneClimbTicks = 0;
    let minFeetY = spawn.y;
    let prevY = spawn.y;
    let arrivedFinal = false;

    for (let t = 0; t < MAX_TICKS; t++) {
      const target = waypoints[Math.min(wp, waypoints.length - 1)];
      const p = motor.position;
      const dx = target[0] - p.x;
      const dz = target[1] - p.z;
      const horiz = Math.hypot(dx, dz);
      // Advance waypoints as we arrive (XZ only — climbing changes y, not the
      // ground-plane target).
      if (horiz < ARRIVE) {
        if (wp < waypoints.length - 1) wp += 1;
        else arrivedFinal = true;
      }
      // forward = (-sin yaw, -cos yaw); choose yaw so forward points at target.
      const yaw = horiz > 1e-4 ? Math.atan2(-dx / horiz, -dz / horiz) : 0;
      const moveY = arrivedFinal && settleAtEnd ? 0 : 1;

      const result = motor.fixedUpdate(STEP, {
        moveX: 0, moveY, yaw, jumpPressed: false, crouch: false, sprint: false,
      });
      const q = motor.position;

      maxSteppedHeight = Math.max(maxSteppedHeight, result.steppedHeight);
      const dyMm = (q.y - prevY) * 1000;
      if (dyMm > maxSingleTickRiseMm) maxSingleTickRiseMm = dyMm;
      if (q.y < minFeetY) minFeetY = q.y;
      if (!reachedDeck && !motor.grounded && q.y > 0.05) airborneClimbTicks += 1;

      if (t < 8 || t % 4 === 0 || reachedDeck) {
        trajectory.push({
          t, x: round(q.x), y: round(q.y), z: round(q.z), wp,
          grounded: motor.grounded, stepped: round(result.steppedHeight),
        });
      }

      if (!reachedDeck && motor.grounded && q.z <= deckInteriorZ
        && Math.abs(q.y - deckTop) < 0.06) {
        reachedDeck = true;
        reachedDeckTick = t;
      }
      if (arrivedFinal && settleAtEnd) {
        const hSpeed = Math.hypot(motor.velocity.x, motor.velocity.z);
        if (hSpeed < 0.03) break;
      }
      prevY = q.y;
    }

    const p = motor.position;
    const final = { x: round(p.x), y: round(p.y), z: round(p.z), grounded: motor.grounded };
    return {
      fits, spawn: spawn.toArray().map((v) => round(v)),
      reachedDeck, reachedDeckTick,
      maxSteppedHeightM: round(maxSteppedHeight, 5),
      maxSingleTickRiseMm: round(maxSingleTickRiseMm, 1),
      airborneClimbTicks, minFeetY: round(minFeetY, 5),
      ticks: trajectory.length ? trajectory[trajectory.length - 1].t + 1 : 0,
      final, trajectory,
    };
  };

  // ── Positive runs: both pads must climb ───────────────────────────────────
  const solver = StaticBoxWorld.fromStaticWorld(world);
  const assertions = [];
  const add = (name, passed, actual, expected) =>
    assertions.push({ name, passed, actual, expected });

  const results = {};
  for (const [name, r] of Object.entries(routes)) {
    // Every ground-level weave waypoint must fit a standing capsule (route-
    // integrity gate). The final waypoint is the objective ON the deck, so it is
    // validated by the drive reaching it, not by a feet-on-floor fit test.
    const groundWps = r.waypoints.slice(0, -1);
    const badWp = groundWps.findIndex((wpt) =>
      !solver.canFit(new THREE.Vector3(wpt[0], 0, wpt[1]), tuning.standingHeight, tuning.radius));
    add(`${name}_waypoints_fit`, badWp === -1,
      { firstBadWaypointIndex: badWp, groundWaypoints: groundWps },
      'every ground-level route waypoint fits a standing capsule (route matches geometry)');

    const run = drive(solver, r.pad, r.waypoints);
    results[name] = run;

    const start = run.trajectory[0];
    add(`${name}_started_on_floor`,
      Math.abs(start.y) < 0.02 && run.trajectory.slice(0, 3).some((s) => s.grounded),
      { startFeetY: start.y, grounded: start.grounded },
      'feet at y≈0 and grounded (began standing on the switchyard floor)');
    add(`${name}_spawn_fits`, run.fits, { fits: run.fits },
      'the deploy pad fits a standing capsule (shipping StaticBoxWorld.canFit)');
    add(`${name}_climb_stays_grounded`, run.airborneClimbTicks === 0,
      { airborneClimbTicks: run.airborneClimbTicks },
      '0 airborne ticks during the climb (no free-fall / hop between treads)');
    add(`${name}_step_up_within_limit`, run.maxSteppedHeightM <= tuning.maxStepHeight + 1e-3,
      { maxSteppedHeightM: run.maxSteppedHeightM, maxStepHeightM: tuning.maxStepHeight },
      `every step-up ≤ maxStepHeight (${tuning.maxStepHeight} m)`);
    add(`${name}_reached_deck`, run.reachedDeck,
      { reachedDeck: run.reachedDeck, reachedDeckTick: run.reachedDeckTick },
      'a grounded tick at deck height, past the south parapet');
    const nearObjective = Math.hypot(run.final.x - objective.position[0], run.final.z - objZ);
    add(`${name}_finished_standing_at_objective`,
      run.final.grounded && Math.abs(run.final.y - deckTop) < 0.06
        && run.final.z <= deckZmax - 0.4 && nearObjective < 1.2,
      { grounded: run.final.grounded, feetY: run.final.y, x: run.final.x, z: run.final.z,
        deckTop, distToObjective: round(nearObjective) },
      `grounded on the deck, feetY≈${deckTop} m, within 1.2 m of the objective hold`);
  }

  // ── Negative control: remove the treads, the SAME west route must FAIL ─────
  const noStepSolids = def.solids.filter((s) => !s.id.startsWith('step-'));
  const noStepWorld = buildStaticWorld({ ...def, solids: noStepSolids });
  const noStepSolver = StaticBoxWorld.fromStaticWorld(noStepWorld);
  const neg = drive(noStepSolver, padA, routeFor(padA, throatW), { settleAtEnd: false });
  add('negative_control_cannot_climb_without_steps', neg.reachedDeck === false,
    { reachedDeck: neg.reachedDeck, finalFeetY: neg.final.y, finalZ: neg.final.z, deckTop },
    'with every `step-*` tread removed the capsule can NOT reach the deck (climb is non-vacuous)');

  const ok = assertions.every((a) => a.passed);

  out.__RELAY_TRAVERSAL__ = {
    at: new Date().toISOString(),
    ok,
    fixedStepHz: 1 / STEP,
    motor: 'shipping PlayerMotor + StaticBoxWorld (src/player, PR #40)',
    world: {
      source: 'buildStaticWorld(buildRelayArena()) — the exact shipped collision',
      boxes: world.boxes.length,
    },
    derivedTargets: {
      deckTop, deckXmin, deckXmax, deckZmin, deckZmax, deckInteriorZ,
      stairXCenter: round(stairXCenter), stairSouthZ: round(stairSouthZ),
      objective: objective.position, throatW, throatE,
    },
    tuning: {
      radius: tuning.radius, standingHeight: tuning.standingHeight,
      walkSpeed: tuning.walkSpeed, gravity: tuning.gravity,
      maxStepHeight: tuning.maxStepHeight, groundSnapDistance: tuning.groundSnapDistance,
    },
    routes: Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, v.waypoints])),
    results,
    negativeControl: {
      reachedDeck: neg.reachedDeck, final: neg.final,
      note: 'same west route, `step-*` removed',
    },
    assertions,
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__RELAY_TRAVERSAL_ERROR__ = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  out.__FRAME_READY__ = true;
}
