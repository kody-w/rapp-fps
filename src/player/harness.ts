import * as THREE from 'three';
import { DEFAULT_PLAYER_TUNING } from './config.js';
import {
  PlayerMotor,
  type PlayerMotorInput,
} from './PlayerMotor.js';
import { StaticCollisionWorld } from './StaticCollisionWorld.js';

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
    rampSlopeDegrees: number;
  };
  measurements: {
    timeTo95PercentWalkSpeedSeconds: number;
    stopTimeSeconds: number;
    stoppingDistanceMeters: number;
    jumpApexMeters: number;
    jumpAirTimeSeconds: number;
    landingImpactMetersPerSecond: number;
    airStrafeVelocityMetersPerSecond: number;
    crouchTransitionSeconds: number;
    crouchTopSpeedMetersPerSecond: number;
    sprintStaminaAfterTwoSeconds: number;
    sprintSpeedAfterTwoSeconds: number;
    stepPeakFeetHeightMeters: number;
    stepFinalZMeters: number;
    stepClearedObstacle: boolean;
    wallFinalZMeters: number;
    rampGroundedThroughout: boolean;
    rampMaxFootGapMeters: number;
    rampMaxOneTickDropMeters: number;
    rampFinalZMeters: number;
    determinismPositionDeltaMeters: number;
    determinismVelocityDeltaMetersPerSecond: number;
    fixedTickCostMicroseconds: number;
    estimatedPlayerCostAt60FpsMilliseconds: number;
    footstepEvents: number;
    landedEvents: number;
  };
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
  const eventCounts: EventCounts = { footsteps: 0, landed: 0, impactSpeed: 0 };

  const openWorld = makeWorld([]);
  const motor = makeMotor(openWorld, eventCounts, new THREE.Vector3(0, 0, 4));
  settle(motor);

  const forward = input({ moveY: 1 });
  let timeTo95 = Number.NaN;
  for (let tick = 1; tick <= 240; tick++) {
    motor.fixedUpdate(FIXED_STEP, forward);
    const speed = horizontalSpeed(motor);
    if (Number.isNaN(timeTo95) && speed >= DEFAULT_PLAYER_TUNING.walkSpeed * 0.95) {
      timeTo95 = tick * FIXED_STEP;
    }
  }

  const stopStart = motor.position.clone();
  let stopTicks = 0;
  while (stopTicks < 240 && horizontalSpeed(motor) > 0.05) {
    motor.fixedUpdate(FIXED_STEP, input());
    stopTicks++;
  }
  const stoppingDistance = horizontalDistance(stopStart, motor.position);

  motor.teleport(new THREE.Vector3(0, 0, 4));
  settle(motor);
  const jumpStartY = motor.position.y;
  let apexY = jumpStartY;
  let airTicks = 0;
  let becameAirborne = false;
  motor.fixedUpdate(FIXED_STEP, input({ jumpPressed: true }));
  for (let tick = 1; tick <= 360; tick++) {
    const strafe = becameAirborne ? 1 : 0;
    motor.fixedUpdate(FIXED_STEP, input({ moveX: strafe }));
    apexY = Math.max(apexY, motor.position.y);
    if (!motor.grounded) {
      becameAirborne = true;
      airTicks++;
    } else if (becameAirborne) {
      break;
    }
  }
  const airStrafeVelocity = Math.abs(motor.velocity.x);

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
  const crouchTopSpeed = horizontalSpeed(motor);

  motor.teleport(new THREE.Vector3(0, 0, 4));
  motor.setCrouched(false);
  motor.stamina = 1;
  settle(motor);
  for (let tick = 0; tick < 240; tick++) {
    motor.fixedUpdate(FIXED_STEP, input({ moveY: 1, sprint: true }));
  }
  const sprintStaminaAfterTwoSeconds = motor.stamina;
  const sprintSpeedAfterTwoSeconds = horizontalSpeed(motor);

  const stepWorld = makeWorld([{ height: 0.3, depth: 2.4 }]);
  const stepMotor = makeMotor(stepWorld, eventCounts, new THREE.Vector3(0, 0, 3));
  settle(stepMotor);
  let stepPeakY = stepMotor.position.y;
  for (let tick = 0; tick < 180; tick++) {
    stepMotor.fixedUpdate(FIXED_STEP, forward);
    stepPeakY = Math.max(stepPeakY, stepMotor.position.y);
  }

  const wallWorld = makeWorld([{ height: 0.8, depth: 0.5 }]);
  const wallMotor = makeMotor(wallWorld, eventCounts, new THREE.Vector3(0, 0, 3));
  settle(wallMotor);
  for (let tick = 0; tick < 240; tick++) {
    wallMotor.fixedUpdate(FIXED_STEP, forward);
  }

  const rampWorld = makeRampWorld();
  const rampSpawnZ = 3.2;
  const rampMotor = makeMotor(
    rampWorld,
    eventCounts,
    new THREE.Vector3(0, rampFootHeight(rampSpawnZ), rampSpawnZ),
  );
  settle(rampMotor);
  let rampGroundedThroughout = rampMotor.grounded;
  let rampMaxFootGap = 0;
  let rampMaxOneTickDrop = 0;
  let previousRampY = rampMotor.position.y;
  for (let tick = 0; tick < 180; tick++) {
    rampMotor.fixedUpdate(FIXED_STEP, forward);
    rampGroundedThroughout &&= rampMotor.grounded;
    rampMaxOneTickDrop = Math.max(
      rampMaxOneTickDrop,
      previousRampY - rampMotor.position.y,
    );
    previousRampY = rampMotor.position.y;
    if (rampMotor.position.z >= 0 && rampMotor.position.z <= RAMP_LENGTH) {
      rampMaxFootGap = Math.max(
        rampMaxFootGap,
        rampMotor.position.y - rampSurfaceHeight(rampMotor.position.z),
      );
    }
  }

  const deterministic30 = runBatchedScenario(openWorld, 30);
  const deterministic144 = runBatchedScenario(openWorld, 144);
  const determinismPositionDelta = deterministic30.position
    .distanceTo(deterministic144.position);
  const determinismVelocityDelta = deterministic30.velocity
    .distanceTo(deterministic144.velocity);

  const benchmark = benchmarkMotor(openWorld);

  checkRange(
    assertions,
    '95% walk speed arrives without an instant velocity snap',
    timeTo95,
    0.12,
    0.24,
    '0.12–0.24 s',
  );
  checkRange(
    assertions,
    'release-to-stop time is responsive, not icy',
    stopTicks * FIXED_STEP,
    0.14,
    0.28,
    '0.14–0.28 s',
  );
  checkRange(
    assertions,
    'stopping distance remains under one body length',
    stoppingDistance,
    0.35,
    0.75,
    '0.35–0.75 m',
  );
  checkRange(
    assertions,
    'jump apex matches the configured traversal height',
    apexY - jumpStartY,
    0.98,
    1.08,
    '0.98–1.08 m',
  );
  checkRange(
    assertions,
    'air control is useful but cannot reverse at ground authority',
    airStrafeVelocity,
    0.8,
    2.2,
    '0.8–2.2 m/s lateral velocity',
  );
  checkRange(
    assertions,
    'crouch transition is quick without being a single tick',
    crouchTicks * FIXED_STEP,
    0.09,
    0.18,
    '0.09–0.18 s',
  );
  checkRange(
    assertions,
    'crouch has a real movement cost',
    crouchTopSpeed,
    2.5,
    2.75,
    '2.50–2.75 m/s',
  );
  checkRange(
    assertions,
    'sprint drains a finite stamina reserve',
    sprintStaminaAfterTwoSeconds,
    0.4,
    0.5,
    '40–50% stamina remaining after 2 s',
  );
  checkRange(
    assertions,
    'sprint reaches its tuned top speed',
    sprintSpeedAfterTwoSeconds,
    7.4,
    7.6,
    '7.4–7.6 m/s',
  );
  checkRange(
    assertions,
    '0.30 m step top is reached',
    stepPeakY,
    0.285,
    0.32,
    'feet reach 0.285–0.320 m',
  );
  checkBoolean(
    assertions,
    '0.30 m step is traversed rather than edge-stalled',
    stepMotor.position.z < -1.2,
    true,
  );
  checkBoolean(
    assertions,
    '0.80 m wall is not climbed',
    wallMotor.position.z > 0.55,
    true,
  );
  checkBoolean(
    assertions,
    '15 degree downhill ramp remains grounded through the flat join',
    rampGroundedThroughout,
    true,
  );
  checkRange(
    assertions,
    '15 degree ramp keeps feet tightly supported by the surface',
    rampMaxFootGap,
    0,
    0.02,
    '≤ 0.020 m vertical foot gap',
  );
  checkRange(
    assertions,
    'ramp-to-flat join has no one-tick vertical drop',
    rampMaxOneTickDrop,
    0,
    0.025,
    '≤ 0.025 m per 120 Hz tick',
  );
  checkBoolean(
    assertions,
    'downhill ramp preserves forward progress',
    rampMotor.position.z < -1.2,
    true,
  );
  checkRange(
    assertions,
    'fixed-step result is independent of render batching',
    determinismPositionDelta,
    0,
    1e-9,
    '≤ 1e-9 m',
  );
  checkRange(
    assertions,
    'player CPU cost stays below 0.25 ms at 60 fps',
    benchmark.estimated60FpsMs,
    0,
    0.25,
    '≤ 0.25 ms',
  );
  checkBoolean(
    assertions,
    'shared footstep event path fired',
    eventCounts.footsteps > 0,
    true,
  );
  checkBoolean(
    assertions,
    'shared landed event path fired',
    eventCounts.landed > 0,
    true,
  );

  const report: PlayerHarnessReport = {
    generatedAt: new Date().toISOString(),
    fixedStepHz: 1 / FIXED_STEP,
    targets: {
      walkSpeedMetersPerSecond: DEFAULT_PLAYER_TUNING.walkSpeed,
      sprintSpeedMetersPerSecond: DEFAULT_PLAYER_TUNING.sprintSpeed,
      jumpHeightMeters: DEFAULT_PLAYER_TUNING.jumpHeight,
      maxStepHeightMeters: DEFAULT_PLAYER_TUNING.maxStepHeight,
      wallHeightMeters: 0.8,
      rampSlopeDegrees: RAMP_SLOPE_DEGREES,
    },
    measurements: {
      timeTo95PercentWalkSpeedSeconds: round(timeTo95),
      stopTimeSeconds: round(stopTicks * FIXED_STEP),
      stoppingDistanceMeters: round(stoppingDistance),
      jumpApexMeters: round(apexY - jumpStartY),
      jumpAirTimeSeconds: round(airTicks * FIXED_STEP),
      landingImpactMetersPerSecond: round(eventCounts.impactSpeed),
      airStrafeVelocityMetersPerSecond: round(airStrafeVelocity),
      crouchTransitionSeconds: round(crouchTicks * FIXED_STEP),
      crouchTopSpeedMetersPerSecond: round(crouchTopSpeed),
      sprintStaminaAfterTwoSeconds: round(sprintStaminaAfterTwoSeconds),
      sprintSpeedAfterTwoSeconds: round(sprintSpeedAfterTwoSeconds),
      stepPeakFeetHeightMeters: round(stepPeakY),
      stepFinalZMeters: round(stepMotor.position.z),
      stepClearedObstacle: stepMotor.position.z < -1.2,
      wallFinalZMeters: round(wallMotor.position.z),
      rampGroundedThroughout,
      rampMaxFootGapMeters: round(rampMaxFootGap),
      rampMaxOneTickDropMeters: round(rampMaxOneTickDrop),
      rampFinalZMeters: round(rampMotor.position.z),
      determinismPositionDeltaMeters: round(determinismPositionDelta, 12),
      determinismVelocityDeltaMetersPerSecond: round(determinismVelocityDelta, 12),
      fixedTickCostMicroseconds: round(benchmark.microsecondsPerTick),
      estimatedPlayerCostAt60FpsMilliseconds: round(benchmark.estimated60FpsMs),
      footstepEvents: eventCounts.footsteps,
      landedEvents: eventCounts.landed,
    },
    assertions,
    passed: assertions.every((assertion) => assertion.passed),
  };

  openWorld.dispose();
  stepWorld.dispose();
  wallWorld.dispose();
  rampWorld.dispose();
  return report;
}

function makeMotor(
  world: StaticCollisionWorld,
  counts: EventCounts,
  spawn: THREE.Vector3,
): PlayerMotor {
  return new PlayerMotor(world, spawn, DEFAULT_PLAYER_TUNING, {
    footstep: () => counts.footsteps++,
    landed: ({ impactSpeed }) => {
      counts.landed++;
      counts.impactSpeed = Math.max(counts.impactSpeed, impactSpeed);
    },
  });
}

function makeWorld(
  obstacles: Array<{ height: number; depth: number }>,
): StaticCollisionWorld {
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  const geometries: THREE.BufferGeometry[] = [];

  const floorGeometry = new THREE.BoxGeometry(80, 0.2, 80);
  const floor = new THREE.Mesh(floorGeometry, material);
  floor.position.y = -0.1;
  floor.userData.surface = 'concrete';
  scene.add(floor);
  geometries.push(floorGeometry);

  for (const obstacle of obstacles) {
    const geometry = new THREE.BoxGeometry(4, obstacle.height, obstacle.depth);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, obstacle.height / 2, 0);
    mesh.userData.surface = 'metal';
    scene.add(mesh);
    geometries.push(geometry);
  }

  const world = StaticCollisionWorld.fromScene(scene);
  for (const geometry of geometries) geometry.dispose();
  material.dispose();
  return world;
}

const RAMP_SLOPE_DEGREES = 15;
const RAMP_SLOPE_RADIANS = THREE.MathUtils.degToRad(RAMP_SLOPE_DEGREES);
const RAMP_LENGTH = 4;

function makeRampWorld(): StaticCollisionWorld {
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  const geometries: THREE.BufferGeometry[] = [];

  const floorGeometry = new THREE.BoxGeometry(80, 0.2, 80);
  const floor = new THREE.Mesh(floorGeometry, material);
  floor.position.y = -0.1;
  floor.userData.surface = 'concrete';
  scene.add(floor);
  geometries.push(floorGeometry);

  const rampGeometry = new THREE.BufferGeometry();
  const rampHeight = rampSurfaceHeight(RAMP_LENGTH);
  rampGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      -2, 0, 0,
      -2, rampHeight, RAMP_LENGTH,
      2, rampHeight, RAMP_LENGTH,
      -2, 0, 0,
      2, rampHeight, RAMP_LENGTH,
      2, 0, 0,
    ], 3),
  );
  const ramp = new THREE.Mesh(rampGeometry, material);
  ramp.userData.surface = 'metal';
  scene.add(ramp);
  geometries.push(rampGeometry);

  const world = StaticCollisionWorld.fromScene(scene);
  for (const geometry of geometries) geometry.dispose();
  material.dispose();
  return world;
}

function rampSurfaceHeight(z: number): number {
  return Math.tan(RAMP_SLOPE_RADIANS) * z;
}

function rampFootHeight(z: number): number {
  return rampSurfaceHeight(z)
    + DEFAULT_PLAYER_TUNING.radius * (1 / Math.cos(RAMP_SLOPE_RADIANS) - 1);
}

function settle(motor: PlayerMotor): void {
  for (let tick = 0; tick < 8; tick++) {
    motor.fixedUpdate(FIXED_STEP, input());
  }
}

function input(overrides: Partial<PlayerMotorInput> = {}): PlayerMotorInput {
  return {
    moveX: 0,
    moveY: 0,
    yaw: 0,
    jumpPressed: false,
    crouch: false,
    sprint: false,
    ...overrides,
  };
}

function horizontalSpeed(motor: PlayerMotor): number {
  return Math.hypot(motor.velocity.x, motor.velocity.z);
}

function horizontalDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function runBatchedScenario(
  world: StaticCollisionWorld,
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

  return {
    position: motor.position.clone(),
    velocity: motor.velocity.clone(),
  };
}

function benchmarkMotor(
  world: StaticCollisionWorld,
): { microsecondsPerTick: number; estimated60FpsMs: number } {
  const motor = new PlayerMotor(world, new THREE.Vector3(-12, 0, -12));
  settle(motor);
  const iterations = 12_000;
  const start = performance.now();
  for (let tick = 0; tick < iterations; tick++) {
    if (tick > 0 && tick % 1200 === 0) {
      motor.teleport(new THREE.Vector3(-12, 0, -12));
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
  return {
    microsecondsPerTick,
    estimated60FpsMs: microsecondsPerTick * 2 / 1000,
  };
}

function checkRange(
  assertions: HarnessAssertion[],
  name: string,
  actual: number,
  min: number,
  max: number,
  expected: string,
): void {
  assertions.push({
    name,
    passed: Number.isFinite(actual) && actual >= min && actual <= max,
    actual: round(actual, 12),
    expected,
  });
}

function checkBoolean(
  assertions: HarnessAssertion[],
  name: string,
  actual: boolean,
  expected: boolean,
): void {
  assertions.push({
    name,
    passed: actual === expected,
    actual,
    expected: String(expected),
  });
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
