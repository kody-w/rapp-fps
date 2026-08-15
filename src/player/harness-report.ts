/**
 * Deterministic player harness. Pure physics, no rendering.
 *
 * This is the witness for every feel claim the subsystem makes. It runs the
 * motor against the axis-aligned box solver at a fixed 120 Hz and asserts the
 * numbers a player would describe — walk ramp, stop, jump, air control, crouch,
 * sprint, a 0.30 m step climbed, a 0.80 m wall refused, a wall slid along, a
 * staircase descended while grounded — plus fixed-step determinism and CPU cost.
 *
 * It deliberately makes NO slope claim. Slopes cannot be expressed in this
 * world, and the registration guard is asserted directly: a degenerate,
 * out-of-bounds or empty world must throw when the solver is built.
 */

import * as THREE from 'three';
import type { StaticBox, StaticWorld, SurfaceMaterial } from '../core/collision.js';
import { DEFAULT_PLAYER_TUNING } from './config.js';
import { PlayerMotor, type PlayerMotorInput } from './PlayerMotor.js';
import { StaticBoxWorld } from './StaticBoxWorld.js';

const FIXED_STEP = 1 / 120;

export interface HarnessAssertion {
  name: string;
  passed: boolean;
  actual: number | boolean;
  expected: string;
}

export interface PlayerHarnessReport {
  generatedAt: string;
  fixedStepHz: number;
  targets: {
    walkSpeedMetersPerSecond: number;
    sprintSpeedMetersPerSecond: number;
    jumpHeightMeters: number;
    maxStepHeightMeters: number;
    wallHeightMeters: number;
  };
  measurements: Record<string, number | boolean>;
  assertions: HarnessAssertion[];
  passed: boolean;
}

interface EventCounts {
  footsteps: number;
  landed: number;
  impactSpeed: number;
}

export function runPlayerHarness(): PlayerHarnessReport {
  const assertions: HarnessAssertion[] = [];
  const counts: EventCounts = { footsteps: 0, landed: 0, impactSpeed: 0 };
  const forward = input({ moveY: 1 });

  // ── Flat-ground feel (open world) ──────────────────────────────────────
  const open = box(0, -0.5, 0, 400, 1, 400, 'concrete');
  const openWorld = worldOf([open]);
  const motor = makeMotor(openWorld, counts, new THREE.Vector3(0, 0, 4));
  settle(motor);

  let timeTo95 = Number.NaN;
  for (let tick = 1; tick <= 240; tick++) {
    motor.fixedUpdate(FIXED_STEP, forward);
    if (Number.isNaN(timeTo95) && speed(motor) >= DEFAULT_PLAYER_TUNING.walkSpeed * 0.95) {
      timeTo95 = tick * FIXED_STEP;
    }
  }

  const stopStart = motor.position.clone();
  let stopTicks = 0;
  while (stopTicks < 240 && speed(motor) > 0.05) {
    motor.fixedUpdate(FIXED_STEP, input());
    stopTicks++;
  }
  const stoppingDistance = planarDistance(stopStart, motor.position);

  // Jump apex + air control.
  motor.teleport(new THREE.Vector3(0, 0, 4));
  settle(motor);
  const jumpStartY = motor.position.y;
  let apexY = jumpStartY;
  let airTicks = 0;
  let airborne = false;
  motor.fixedUpdate(FIXED_STEP, input({ jumpPressed: true }));
  for (let tick = 1; tick <= 360; tick++) {
    motor.fixedUpdate(FIXED_STEP, input({ moveX: airborne ? 1 : 0 }));
    apexY = Math.max(apexY, motor.position.y);
    if (!motor.grounded) { airborne = true; airTicks++; } else if (airborne) break;
  }
  const airStrafeVelocity = Math.abs(motor.velocity.x);

  // Crouch transition + cost.
  motor.teleport(new THREE.Vector3(0, 0, 4));
  motor.setCrouched(false);
  settle(motor);
  let crouchTicks = 0;
  while (crouchTicks < 120
    && motor.colliderHeight > DEFAULT_PLAYER_TUNING.crouchingHeight + 1e-4) {
    motor.fixedUpdate(FIXED_STEP, input({ crouch: true }));
    crouchTicks++;
  }
  for (let tick = 0; tick < 180; tick++) {
    motor.fixedUpdate(FIXED_STEP, input({ moveY: 1, crouch: true }));
  }
  const crouchTopSpeed = speed(motor);

  // Sprint stamina + top speed.
  motor.teleport(new THREE.Vector3(0, 0, 4));
  motor.setCrouched(false);
  motor.stamina = 1;
  settle(motor);
  for (let tick = 0; tick < 240; tick++) {
    motor.fixedUpdate(FIXED_STEP, input({ moveY: 1, sprint: true }));
  }
  const sprintStamina = motor.stamina;
  const sprintSpeed = speed(motor);

  // ── 0.30 m step is climbed ─────────────────────────────────────────────
  const stepWorld = worldOf([open, box(0, 0.15, 0, 4, 0.3, 2.4, 'metal')]);
  const stepMotor = makeMotor(stepWorld, counts, new THREE.Vector3(0, 0, 3));
  settle(stepMotor);
  let stepPeakY = stepMotor.position.y;
  for (let tick = 0; tick < 180; tick++) {
    stepMotor.fixedUpdate(FIXED_STEP, forward);
    stepPeakY = Math.max(stepPeakY, stepMotor.position.y);
  }

  // ── 0.80 m wall is refused ─────────────────────────────────────────────
  const wallWorld = worldOf([open, box(0, 0.4, 0, 4, 0.8, 0.5, 'concrete')]);
  const wallMotor = makeMotor(wallWorld, counts, new THREE.Vector3(0, 0, 3));
  settle(wallMotor);
  for (let tick = 0; tick < 240; tick++) wallMotor.fixedUpdate(FIXED_STEP, forward);
  const wallFinalZ = wallMotor.position.z;
  const wallFinalY = wallMotor.position.y;

  // ── Diagonal into a tall wall slides along it ──────────────────────────
  const slideWorld = worldOf([open, box(0, 1.5, 0, 12, 3, 0.6, 'metal')]);
  const slideMotor = makeMotor(slideWorld, counts, new THREE.Vector3(0, 0, 3));
  settle(slideMotor);
  for (let tick = 0; tick < 180; tick++) {
    slideMotor.fixedUpdate(FIXED_STEP, input({ moveX: 1, moveY: 1 }));
  }
  const slideAlongX = Math.abs(slideMotor.position.x);
  const slideStoppedZ = slideMotor.position.z;

  // ── Staircase descent stays grounded, no cm-scale pops ─────────────────
  // The box-world positive control against which the prior finite-ramp defect
  // (the committed fixture reproduces 116-154 mm single-tick pops; the original
  // review reported ~2 airborne ticks and 45-57 mm) is contrasted: on boxes the
  // walker stays glued and steps down cleanly.
  const stairWorld = worldOf([
    open,
    box(0, 0.6, 0, 6, 1.2, 4, 'wood'),
    box(0, 0.45, -2.4, 6, 0.9, 0.8, 'metal'),
    box(0, 0.30, -3.2, 6, 0.6, 0.8, 'metal'),
    box(0, 0.15, -4.0, 6, 0.3, 0.8, 'metal'),
  ]);
  const stairMotor = makeMotor(stairWorld, counts, new THREE.Vector3(0, 1.2, 1));
  settle(stairMotor);
  let stairGrounded = stairMotor.grounded;
  let stairMaxDrop = 0;
  let previousY = stairMotor.position.y;
  let reachedFloor = false;
  for (let tick = 0; tick < 200; tick++) {
    stairMotor.fixedUpdate(FIXED_STEP, forward);
    if (stairMotor.position.z < -5) reachedFloor = true;
    // Only judge grounding/pops while traversing the stair run, not after
    // reaching the flat floor beyond it.
    if (!reachedFloor) {
      stairGrounded &&= stairMotor.grounded;
      stairMaxDrop = Math.max(stairMaxDrop, previousY - stairMotor.position.y);
    }
    previousY = stairMotor.position.y;
  }
  // ── Fixed-step determinism across render batching ──────────────────────
  const at30 = batched(openWorld, 30);
  const at144 = batched(openWorld, 144);
  const posDelta = at30.position.distanceTo(at144.position);
  const velDelta = at30.velocity.distanceTo(at144.velocity);

  // ── CPU cost ───────────────────────────────────────────────────────────
  const bench = benchmark(stairWorld);

  // ── Registration guard (unreachable slope path) ────────────────────────
  const degenerateThrows = throwsOnBuild({
    boxes: [{ min: [0, 0, 0], max: [1, 0, 1], material: 'concrete' }],
    bounds: { min: [-1, -1, -1], max: [2, 2, 2] },
  });
  const outOfBoundsThrows = throwsOnBuild({
    boxes: [{ min: [0, 0, 0], max: [100, 1, 1], material: 'concrete' }],
    bounds: { min: [-1, -1, -1], max: [2, 2, 2] },
  });
  const emptyThrows = throwsOnBuild({
    boxes: [],
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  });

  range(assertions, '95% walk speed arrives without an instant velocity snap', timeTo95, 0.12, 0.24, '0.12-0.24 s');
  range(assertions, 'release-to-stop time is responsive, not icy', stopTicks * FIXED_STEP, 0.14, 0.28, '0.14-0.28 s');
  range(assertions, 'stopping distance stays under one body length', stoppingDistance, 0.35, 0.75, '0.35-0.75 m');
  range(assertions, 'jump apex matches the configured height', apexY - jumpStartY, 0.98, 1.08, '0.98-1.08 m');
  range(assertions, 'air control is useful but cannot reverse at ground authority', airStrafeVelocity, 0.8, 2.2, '0.8-2.2 m/s');
  range(assertions, 'crouch transition is quick without being a single tick', crouchTicks * FIXED_STEP, 0.09, 0.18, '0.09-0.18 s');
  range(assertions, 'crouch has a real movement cost', crouchTopSpeed, 2.5, 2.75, '2.50-2.75 m/s');
  range(assertions, 'sprint drains a finite stamina reserve', sprintStamina, 0.4, 0.5, '40-50% after 2 s');
  range(assertions, 'sprint reaches its tuned top speed', sprintSpeed, 7.4, 7.6, '7.4-7.6 m/s');
  range(assertions, '0.30 m step top is reached', stepPeakY, 0.285, 0.32, 'feet 0.285-0.320 m');
  bool(assertions, '0.30 m step is traversed rather than edge-stalled', stepMotor.position.z < -1.2, true);
  bool(assertions, '0.80 m wall is not climbed', wallFinalZ > 0.55 && wallFinalY < 0.05, true);
  bool(assertions, 'diagonal into a wall slides rather than sticking', slideAlongX > 1.5 && slideStoppedZ > 0, true);
  bool(assertions, 'staircase descent stays glued to the ground', stairGrounded, true);
  range(assertions, 'staircase body step-down is bounded by the riser, never a free-fall', stairMaxDrop, 0, DEFAULT_PLAYER_TUNING.maxStepHeight + 0.02, '<= riser (0.36 m) per tick');
  bool(assertions, 'staircase descent preserves forward progress', reachedFloor, true);
  range(assertions, 'fixed-step result is independent of render batching (position)', posDelta, 0, 1e-9, '<= 1e-9 m');
  range(assertions, 'fixed-step result is independent of render batching (velocity)', velDelta, 0, 1e-9, '<= 1e-9 m/s');
  range(assertions, 'player CPU cost stays below 0.25 ms at 60 fps', bench.estimated60FpsMs, 0, 0.25, '<= 0.25 ms');
  bool(assertions, 'shared footstep event path fired', counts.footsteps > 0, true);
  bool(assertions, 'shared landed event path fired', counts.landed > 0, true);
  bool(assertions, 'degenerate box is rejected at registration', degenerateThrows, true);
  bool(assertions, 'out-of-bounds box is rejected at registration', outOfBoundsThrows, true);
  bool(assertions, 'empty world is rejected at registration', emptyThrows, true);

  return {
    generatedAt: new Date().toISOString(),
    fixedStepHz: 1 / FIXED_STEP,
    targets: {
      walkSpeedMetersPerSecond: DEFAULT_PLAYER_TUNING.walkSpeed,
      sprintSpeedMetersPerSecond: DEFAULT_PLAYER_TUNING.sprintSpeed,
      jumpHeightMeters: DEFAULT_PLAYER_TUNING.jumpHeight,
      maxStepHeightMeters: DEFAULT_PLAYER_TUNING.maxStepHeight,
      wallHeightMeters: 0.8,
    },
    measurements: {
      timeTo95PercentWalkSpeedSeconds: round(timeTo95),
      stopTimeSeconds: round(stopTicks * FIXED_STEP),
      stoppingDistanceMeters: round(stoppingDistance),
      jumpApexMeters: round(apexY - jumpStartY),
      jumpAirTimeSeconds: round(airTicks * FIXED_STEP),
      landingImpactMetersPerSecond: round(counts.impactSpeed),
      airStrafeVelocityMetersPerSecond: round(airStrafeVelocity),
      crouchTransitionSeconds: round(crouchTicks * FIXED_STEP),
      crouchTopSpeedMetersPerSecond: round(crouchTopSpeed),
      sprintStaminaAfterTwoSeconds: round(sprintStamina),
      sprintSpeedAfterTwoSeconds: round(sprintSpeed),
      stepPeakFeetHeightMeters: round(stepPeakY),
      stepFinalZMeters: round(stepMotor.position.z),
      wallFinalZMeters: round(wallFinalZ),
      wallFinalFeetYMeters: round(wallFinalY),
      wallSlideAlongXMeters: round(slideAlongX),
      wallSlideStoppedZMeters: round(slideStoppedZ),
      stairGroundedThroughout: stairGrounded,
      stairMaxBodyStepDownMeters: round(stairMaxDrop),
      stairReachedFloor: reachedFloor,
      determinismPositionDeltaMeters: round(posDelta, 12),
      determinismVelocityDeltaMetersPerSecond: round(velDelta, 12),
      fixedTickCostMicroseconds: round(bench.microsecondsPerTick),
      estimatedPlayerCostAt60FpsMilliseconds: round(bench.estimated60FpsMs),
      footstepEvents: counts.footsteps,
      landedEvents: counts.landed,
    },
    assertions,
    passed: assertions.every((assertion) => assertion.passed),
  };
}

function box(
  cx: number, cy: number, cz: number,
  sx: number, sy: number, sz: number,
  material: SurfaceMaterial,
): StaticBox {
  return {
    min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
    max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
    material,
  };
}

function worldOf(boxes: StaticBox[]): StaticBoxWorld {
  const world: StaticWorld = {
    boxes,
    bounds: { min: [-300, -5, -300], max: [300, 60, 300] },
  };
  return StaticBoxWorld.fromStaticWorld(world);
}

function makeMotor(world: StaticBoxWorld, counts: EventCounts, spawn: THREE.Vector3): PlayerMotor {
  return new PlayerMotor(world, spawn, DEFAULT_PLAYER_TUNING, {
    footstep: () => { counts.footsteps++; },
    landed: ({ impactSpeed }) => {
      counts.landed++;
      counts.impactSpeed = Math.max(counts.impactSpeed, impactSpeed);
    },
  });
}

function throwsOnBuild(world: StaticWorld): boolean {
  try {
    StaticBoxWorld.fromStaticWorld(world);
    return false;
  } catch {
    return true;
  }
}

function settle(motor: PlayerMotor): void {
  for (let tick = 0; tick < 8; tick++) motor.fixedUpdate(FIXED_STEP, input());
}

function input(overrides: Partial<PlayerMotorInput> = {}): PlayerMotorInput {
  return { moveX: 0, moveY: 0, yaw: 0, jumpPressed: false, crouch: false, sprint: false, ...overrides };
}

function speed(motor: PlayerMotor): number {
  return Math.hypot(motor.velocity.x, motor.velocity.z);
}

function planarDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function batched(
  world: StaticBoxWorld,
  renderRate: number,
): { position: THREE.Vector3; velocity: THREE.Vector3 } {
  const motor = new PlayerMotor(world, new THREE.Vector3(12, 0, 12));
  settle(motor);
  let accumulator = 0;
  let tick = 0;
  while (tick < 360) {
    accumulator += 1 / renderRate;
    while (accumulator + 1e-12 >= FIXED_STEP && tick < 360) {
      motor.fixedUpdate(FIXED_STEP, input({
        moveY: tick < 180 ? 1 : 0,
        moveX: tick >= 90 && tick < 240 ? 0.65 : 0,
        yaw: tick >= 180 ? -0.45 : 0,
        jumpPressed: tick === 75,
        sprint: tick < 120,
      }));
      accumulator -= FIXED_STEP;
      tick++;
    }
  }
  return { position: motor.position.clone(), velocity: motor.velocity.clone() };
}

function benchmark(world: StaticBoxWorld): { microsecondsPerTick: number; estimated60FpsMs: number } {
  const motor = new PlayerMotor(world, new THREE.Vector3(0, 1.2, 1));
  settle(motor);
  const iterations = 12_000;
  const start = performance.now();
  for (let tick = 0; tick < iterations; tick++) {
    if (tick > 0 && tick % 1200 === 0) {
      motor.teleport(new THREE.Vector3(0, 1.2, 1));
      settle(motor);
    }
    motor.fixedUpdate(FIXED_STEP, input({
      moveY: 1,
      moveX: Math.sin(tick * 0.013) * 0.7,
      yaw: tick * 0.004,
      sprint: tick % 720 < 360,
      jumpPressed: tick % 480 === 120,
    }));
  }
  const elapsedMs = performance.now() - start;
  const microsecondsPerTick = elapsedMs * 1000 / iterations;
  // Two fixed ticks per 60 fps frame.
  return { microsecondsPerTick, estimated60FpsMs: microsecondsPerTick * 2 / 1000 };
}

function range(
  assertions: HarnessAssertion[],
  name: string, actual: number, min: number, max: number, expected: string,
): void {
  assertions.push({
    name,
    passed: Number.isFinite(actual) && actual >= min && actual <= max,
    actual: round(actual, 12),
    expected,
  });
}

function bool(assertions: HarnessAssertion[], name: string, actual: boolean, expected: boolean): void {
  assertions.push({ name, passed: actual === expected, actual, expected: String(expected) });
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
