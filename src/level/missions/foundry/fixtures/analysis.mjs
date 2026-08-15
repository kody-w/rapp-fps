/**
 * Foundry analysis harness (Mission 3, issue #73; parent level #70).
 *
 * A single headless page that runs every non-visual gate against the EXACT
 * shipping modules — the real `StaticWorld` from `buildStaticWorld(buildFoundry())`
 * and the shipping `PlayerMotor`/`StaticBoxWorld` (src/player) — and publishes
 * one structured report on `window.__FOUNDRY_ANALYSIS__` for the playwright
 * runner (`run-analysis.mjs`) to assert on and archive.
 *
 * Gates covered here (visuals + timing + correspondence are separate, via the
 * shot tool and the shared correspondence verifier against harness.html):
 *   1. world       — core validation + <=45 collidable boxes.
 *   2. spawns      — two feet-based spawns, capsule clearance, inside bounds.
 *   3. los         — initial line-of-sight policy, measured from both spawns.
 *   4. route       — shipping motor floor → casting lane → stair → console,
 *                    every rise <= 0.34 m, zero airborne climb ticks, PLUS a
 *                    sabotaged negative control that MUST fail (proving the
 *                    positive proof is not vacuous).
 *   5. fingerprint — topology distinct from the cargo bay on bounds, count, id,
 *                    route (vertical) and sightline; no relay import.
 *
 * `.mjs` on purpose: runtime test glue, excluded from `tsc` (allowJs off), so
 * the typed build stays clean while this imports the player subsystem at run
 * time. Vite transforms the imported `.ts` modules.
 */

import * as THREE from 'three';
import { buildFoundry } from '../foundry.js';
import { buildArena } from '../../../arena.js';
import { buildStaticWorld, collidableSolids } from '../../../staticWorld.js';
import { assertValidStaticWorld } from '../../../../core/collision.js';
import { compareTopology } from '../fingerprint.js';
import { firstOccluder } from '../los.js';
import { PlayerMotor } from '../../../../player/PlayerMotor.js';
import { StaticBoxWorld } from '../../../../player/StaticBoxWorld.js';
import { DEFAULT_PLAYER_TUNING } from '../../../../player/config.js';

const out = window;
const STEP = 1 / 120;
const MAX_COLLIDABLE = 45;

const round = (v, d = 4) => {
  const s = 10 ** d;
  return Math.round(v * s) / s;
};

/**
 * Objective arrival radius derived from the AUTHORED `FinalObjective.footprint`:
 * the footprint's diagonal reach plus the player's own capsule radius. There is
 * no magic constant — halving the authored footprint shrinks this radius, so the
 * acceptance test is controlled by the field (proven non-vacuously below).
 */
function objectiveArrivalRadius(footprint, playerRadius) {
  return Math.hypot(footprint[0], footprint[1]) + playerRadius;
}

/** Drive the shipping motor along feet-space waypoints with plain forward
 *  intent (steer yaw toward the next waypoint; never teleport). */
function driveRoute(solver, tuning, spawn, waypoints, objective) {
  const motor = new PlayerMotor(solver, new THREE.Vector3(...spawn), tuning);
  const gTop = objective.standHeight;
  const objXZ = [objective.location[0], objective.location[2]];
  const MAX_TICKS = 3000;

  const traj = [];
  let wpIndex = 1; // waypoints[0] is the spawn; head to [1]
  let maxStepped = 0;
  let maxRiseMm = 0;
  let airborneClimb = 0;
  let minFeetY = spawn[1];
  let reachedGantry = false;
  let reachedGantryTick = -1;
  let prevY = spawn[1];

  for (let t = 0; t < MAX_TICKS; t++) {
    const target = waypoints[Math.min(wpIndex, waypoints.length - 1)];
    const dx = target[0] - motor.position.x;
    const dz = target[2] - motor.position.z;
    const yaw = Math.atan2(-dx, -dz); // forward=(-sin,−cos) points at target

    const res = motor.fixedUpdate(STEP, {
      moveX: 0, moveY: 1, yaw, jumpPressed: false, crouch: false, sprint: false,
    });
    const p = motor.position;

    maxStepped = Math.max(maxStepped, res.steppedHeight);
    const dyMm = (p.y - prevY) * 1000;
    if (dyMm > maxRiseMm) maxRiseMm = dyMm;
    if (p.y < minFeetY) minFeetY = p.y;
    if (!reachedGantry && !motor.grounded && p.y > 0.05) airborneClimb += 1;

    traj.push({
      t, x: round(p.x), y: round(p.y), z: round(p.z),
      grounded: motor.grounded, stepped: round(res.steppedHeight), wp: wpIndex,
    });

    const hd = Math.hypot(target[0] - p.x, target[2] - p.z);
    const vd = Math.abs(p.y - target[1]);
    if (hd < 0.7 && vd < 0.3 && wpIndex < waypoints.length - 1) wpIndex += 1;

    if (!reachedGantry && motor.grounded && Math.abs(p.y - gTop) < 0.06) {
      reachedGantry = true;
      reachedGantryTick = t;
    }
    if (wpIndex === waypoints.length - 1) {
      const hEnd = Math.hypot(target[0] - p.x, target[2] - p.z);
      const hSpeed = Math.hypot(motor.velocity.x, motor.velocity.z);
      if (hEnd < 0.6 && hSpeed < 0.05) break;
    }
    prevY = p.y;
  }

  const final = traj[traj.length - 1];
  const start = traj[0];
  const hToObj = Math.hypot(objXZ[0] - final.x, objXZ[1] - final.z);
  const arrivalRadius = objectiveArrivalRadius(objective.footprint, tuning.radius);
  const arrivalRadiusHalfFootprint = objectiveArrivalRadius(
    [objective.footprint[0] / 2, objective.footprint[1] / 2], tuning.radius,
  );
  const reachedObjective = final.grounded
    && Math.abs(final.y - gTop) < 0.06
    && hToObj <= arrivalRadius;
  // Non-vacuous: the SAME arrival distance, judged against a HALVED authored
  // footprint, would be rejected — so `FinalObjective.footprint` (not a constant)
  // controls acceptance. Accepted now AND would-reject-if-smaller = field-driven.
  const footprintControlsAcceptance = hToObj <= arrivalRadius && hToObj > arrivalRadiusHalfFootprint;

  return {
    ticks: traj.length,
    start,
    final,
    maxSteppedHeightM: round(maxStepped, 5),
    maxSingleTickRiseMm: round(maxRiseMm, 1),
    airborneClimbTicks: airborneClimb,
    minFeetY: round(minFeetY, 5),
    reachedGantry,
    reachedGantryTick,
    objectiveFootprint: objective.footprint,
    arrivalRadiusM: round(arrivalRadius, 3),
    arrivalRadiusHalfFootprintM: round(arrivalRadiusHalfFootprint, 3),
    footprintControlsAcceptance,
    hToObjectiveM: round(hToObj, 3),
    reachedObjective,
    trajectory: traj,
  };
}

try {
  const def = buildFoundry();
  const world = buildStaticWorld(def);
  const solver = StaticBoxWorld.fromStaticWorld(world);
  const tuning = DEFAULT_PLAYER_TUNING;
  const collidable = collidableSolids(def);
  const EYE = tuning.standingEyeHeight;

  // ── 1. World validation + collidable ceiling ─────────────────────────────
  let worldValid = true;
  let worldDetail = 'assertValidStaticWorld passed';
  try {
    assertValidStaticWorld(world);
  } catch (err) {
    worldValid = false;
    worldDetail = String(err && err.message ? err.message : err);
  }
  const worldReport = {
    collidableBoxes: world.boxes.length,
    ceiling: MAX_COLLIDABLE,
    withinCeiling: world.boxes.length <= MAX_COLLIDABLE,
    valid: worldValid,
    detail: worldDetail,
  };

  // ── 2. Spawn clearance + bounds (two feet-based slots) ───────────────────
  const b = world.bounds;
  const spawnEval = def.playerSpawns.map((s, i) => {
    const v = new THREE.Vector3(...s);
    const fits = solver.canFit(v, tuning.standingHeight, tuning.radius);
    const insideBounds = s[0] > b.min[0] + tuning.radius && s[0] < b.max[0] - tuning.radius
      && s[2] > b.min[2] + tuning.radius && s[2] < b.max[2] - tuning.radius
      && s[1] >= b.min[1] && s[1] <= b.max[1];
    return { slot: i, spawn: s, feetOnFloor: Math.abs(s[1]) < 1e-6, fits, insideBounds };
  });
  const sep = Math.hypot(
    def.playerSpawns[0][0] - def.playerSpawns[1][0],
    def.playerSpawns[0][2] - def.playerSpawns[1][2],
  );
  const spawnsReport = {
    radius: tuning.radius,
    standingHeight: tuning.standingHeight,
    slots: spawnEval,
    minSeparationM: round(sep, 3),
    allClear: spawnEval.every((e) => e.fits && e.insideBounds && e.feetOnFloor),
    twoDistinctSpawns: def.playerSpawns.length === 2 && sep > 2.0,
  };

  // Enemy spawn clearance — an explicit gate, not assumed. The defender must also
  // stand in a clear, in-bounds, floor-level cell; measured with the SAME shipping
  // capsule yardstick (radius/standing height) used for the player slots.
  const enemyV = new THREE.Vector3(...def.enemySpawn);
  const enemyFits = solver.canFit(enemyV, tuning.standingHeight, tuning.radius);
  const enemyInsideBounds = def.enemySpawn[0] > b.min[0] + tuning.radius && def.enemySpawn[0] < b.max[0] - tuning.radius
    && def.enemySpawn[2] > b.min[2] + tuning.radius && def.enemySpawn[2] < b.max[2] - tuning.radius
    && def.enemySpawn[1] >= b.min[1] && def.enemySpawn[1] <= b.max[1];
  const enemySpawnReport = {
    spawn: def.enemySpawn,
    capsule: { radius: tuning.radius, standingHeight: tuning.standingHeight },
    feetOnFloor: Math.abs(def.enemySpawn[1]) < 1e-6,
    fits: enemyFits,
    insideBounds: enemyInsideBounds,
    clear: enemyFits && enemyInsideBounds && Math.abs(def.enemySpawn[1]) < 1e-6,
  };

  // ── 3. Initial line-of-sight policy (measured, not assumed) ──────────────
  // Policy: the defended final objective must be OCCLUDED from BOTH spawns'
  // standing eye — the finale is not won on sight from the door. Spawn→enemy is
  // reported for context.
  const objTarget = def.finalObjective.location;
  const losFromSpawns = def.playerSpawns.map((s, i) => {
    const from = [s[0], s[1] + EYE, s[2]];
    const occ = firstOccluder(collidable, from, objTarget, [def.finalObjective.id]);
    const enemyTo = [def.enemySpawn[0], def.enemySpawn[1] + 1.2, def.enemySpawn[2]];
    const enemyOcc = firstOccluder(collidable, from, enemyTo);
    return {
      slot: i,
      objectiveOccluded: occ !== null,
      objectiveFirstOccluder: occ ? occ.id : null,
      enemyOccluded: enemyOcc !== null,
      enemyFirstOccluder: enemyOcc ? enemyOcc.id : null,
    };
  });
  const losReport = {
    policy: 'objective occluded from every player spawn (cover-defended finale)',
    fromSpawns: losFromSpawns,
    objectiveOccludedFromAllSpawns: losFromSpawns.every((l) => l.objectiveOccluded),
  };

  // ── Stair geometry: every designed rise <= maxStepHeight, top flush ──────
  const steps = def.solids.filter((s) => /^step-\d+$/.test(s.id))
    .map((s) => s.max[1]).sort((a, z) => a - z); // ascending tops
  const gantry = def.solids.find((s) => s.id === def.finalObjective.gantryDeckId);
  const rises = [];
  rises.push(round(steps[0], 5)); // floor(0) → lowest tread
  for (let i = 1; i < steps.length; i++) rises.push(round(steps[i] - steps[i - 1], 5));
  const maxDesignedRise = rises.reduce((m, r) => Math.max(m, r), 0);
  const stairReport = {
    stepCount: steps.length,
    treadTops: steps.map((h) => round(h, 4)),
    rises,
    maxDesignedRiseM: maxDesignedRise,
    withinMotorLimit: maxDesignedRise <= tuning.maxStepHeight + 1e-9,
    topTreadFlushWithGantry: gantry ? Math.abs(steps[steps.length - 1] - gantry.max[1]) < 1e-6 : false,
  };

  // ── 4. Route proof (shipping motor) + negative control ───────────────────
  const route = driveRoute(solver, tuning, def.playerSpawn, def.routeWaypoints, def.finalObjective);

  // Sabotage: remove one middle tread so a doubled riser (2×) exceeds the motor
  // limit. The SAME controller must now fail to reach the gantry — otherwise the
  // positive proof above would be meaningless.
  const sabotagedId = 'step-3';
  const sabotagedDef = { ...def, solids: def.solids.filter((s) => s.id !== sabotagedId) };
  const sabotagedWorld = buildStaticWorld(sabotagedDef);
  const sabotagedSolver = StaticBoxWorld.fromStaticWorld(sabotagedWorld);
  const negative = driveRoute(sabotagedSolver, tuning, def.playerSpawn, def.routeWaypoints, def.finalObjective);

  const routeReport = {
    fixedStepHz: 1 / STEP,
    motor: 'shipping PlayerMotor + StaticBoxWorld (src/player)',
    worldBoxes: world.boxes.length,
    positive: route,
    negativeControl: {
      sabotage: `removed ${sabotagedId} (doubled riser > maxStepHeight)`,
      worldBoxes: sabotagedWorld.boxes.length,
      reachedGantry: negative.reachedGantry,
      reachedObjective: negative.reachedObjective,
      final: negative.final,
      ticks: negative.ticks,
    },
  };

  // ── 5. Topology fingerprint vs the cargo bay ─────────────────────────────
  const cargo = buildArena();
  const topo = compareTopology(def, cargo);

  // ── Assertions ───────────────────────────────────────────────────────────
  const assertions = [
    { name: 'world_valid', passed: worldReport.valid, actual: worldReport.detail },
    { name: 'collidable_within_ceiling', passed: worldReport.withinCeiling, actual: { boxes: worldReport.collidableBoxes, ceiling: MAX_COLLIDABLE } },
    { name: 'two_feet_based_spawns_clear', passed: spawnsReport.allClear && spawnsReport.twoDistinctSpawns, actual: { slots: spawnEval, minSeparationM: spawnsReport.minSeparationM } },
    { name: 'enemy_spawn_clear', passed: enemySpawnReport.clear, actual: enemySpawnReport },
    { name: 'initial_los_objective_occluded_from_all_spawns', passed: losReport.objectiveOccludedFromAllSpawns, actual: losFromSpawns },
    { name: 'stair_rises_within_motor_limit', passed: stairReport.withinMotorLimit && stairReport.topTreadFlushWithGantry, actual: { maxDesignedRiseM: stairReport.maxDesignedRiseM, limit: tuning.maxStepHeight, topFlush: stairReport.topTreadFlushWithGantry } },
    { name: 'route_started_on_floor', passed: Math.abs(route.start.y) < 0.02 && route.trajectory.slice(0, 3).some((s) => s.grounded), actual: { startY: route.start.y } },
    { name: 'route_climb_stays_grounded', passed: route.airborneClimbTicks === 0, actual: { airborneClimbTicks: route.airborneClimbTicks } },
    { name: 'route_step_up_within_motor_limit', passed: route.maxSteppedHeightM <= tuning.maxStepHeight + 1e-3 && route.maxSingleTickRiseMm <= tuning.maxStepHeight * 1000 + 1, actual: { maxSteppedHeightM: route.maxSteppedHeightM, maxSingleTickRiseMm: route.maxSingleTickRiseMm, limitMm: tuning.maxStepHeight * 1000 } },
    { name: 'route_reached_final_objective', passed: route.reachedGantry && route.reachedObjective, actual: { reachedGantry: route.reachedGantry, reachedObjective: route.reachedObjective, hToObjectiveM: route.hToObjectiveM, final: route.final } },
    { name: 'objective_acceptance_derived_from_footprint', passed: route.reachedObjective && route.footprintControlsAcceptance, actual: { footprint: route.objectiveFootprint, arrivalRadiusM: route.arrivalRadiusM, arrivalRadiusHalfFootprintM: route.arrivalRadiusHalfFootprintM, hToObjectiveM: route.hToObjectiveM } },
    { name: 'negative_control_fails_climb', passed: !negative.reachedGantry && !negative.reachedObjective, actual: { reachedGantry: negative.reachedGantry, reachedObjective: negative.reachedObjective, finalY: negative.final.y } },
    { name: 'topology_distinct_from_cargo', passed: topo.allDistinct, actual: topo.fields },
  ];
  const ok = assertions.every((a) => a.passed);

  out.__FOUNDRY_ANALYSIS__ = {
    at: new Date().toISOString(),
    ok,
    mission: def.mission,
    tuning: {
      radius: tuning.radius, standingHeight: tuning.standingHeight,
      standingEyeHeight: tuning.standingEyeHeight, walkSpeed: tuning.walkSpeed,
      gravity: tuning.gravity, maxStepHeight: tuning.maxStepHeight,
      groundSnapDistance: tuning.groundSnapDistance,
    },
    world: worldReport,
    spawns: spawnsReport,
    enemySpawn: enemySpawnReport,
    los: losReport,
    stair: stairReport,
    route: routeReport,
    fingerprint: {
      allDistinct: topo.allDistinct,
      fields: topo.fields,
      foundry: topo.a,
      cargo: topo.b,
    },
    assertions,
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__FOUNDRY_ANALYSIS_ERROR__ = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  out.__FRAME_READY__ = true;
}
