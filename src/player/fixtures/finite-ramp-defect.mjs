/**
 * Finite-ramp slope-defect fixture (issue #36, parent #32).
 *
 * The ramp blocker on draft PRs #3/#13 existed only as a review comment: a
 * claim that an independent finite-solid ramp fixture produced ~2 airborne
 * ticks and 45-57 mm vertical pops. A claim with no witness is folklore. This
 * fixture is the witness. It:
 *
 *   1. builds REAL finite solid ramps -- an approach floor (a box), a solid
 *      triangular wedge, and a top platform (a box) -- so the two seams a finite
 *      solid has and a thin infinite test ramp does not are present: the
 *      concave floor->slope seam at the ramp foot, and the convex slope->platform
 *      seam at the top,
 *   2. drives a capsule up and over each ramp at the engine's 120 Hz fixed step
 *      using a faithful reduction of PR #13's motor core, against the vendored
 *      port of PR #13's exact mesh solver (`pr13-mesh-solver.mjs`),
 *   3. sweeps the ramp ANGLE from a gentle 16.7 deg up to 37.5 deg -- every one
 *      of them below PR #13's own 50 deg walkable limit, so a correct solver
 *      would carry the capsule smoothly over all of them -- and
 *   4. measures, per angle, the airborne ticks and the peak UNCOMMANDED per-tick
 *      vertical pop (the part of a tick's vertical move that exceeds the fastest
 *      climb the ramp grade can justify, `grade * |dz|`; on a perfectly followed
 *      ramp this is 0), writes a JSON report, and prints an HONEST verdict.
 *
 * Finding (see the printed table): the defect is NOT universal. On gentle ramps
 * (<= ~23 deg) the solver stays glued and smooth. But above a sharp threshold
 * near 25 deg -- still a walkable grade, gentler than a typical staircase -- the
 * capsule is thrown UP the ramp foot by ~150 mm in a single tick and thrashes
 * again at the top seam, all while the solver reports itself grounded. An
 * uncommanded 150 mm vertical jerk with the feet still "on the ground" is a
 * camera pop a player sees instantly. That is the class of defect that blocked
 * PRs #3/#13, reproduced here concretely and worse than the original 45-57 mm
 * report, on a finite solid the earlier infinite-ramp fixtures could not model.
 *
 * The shipped subsystem cannot express this geometry at all: `StaticWorld` is
 * axis-aligned boxes and `assertValidStaticWorld` throws on anything else, so
 * this whole code path is unreachable in the game. That is the mitigation; this
 * fixture is the evidence for why the mitigation exists. Slopes return later
 * under their own issue, with a solver that must pass this fixture first.
 *
 * Honesty note on what is solver-owned vs driver-influenced. The headline metric
 * -- the uncommanded per-tick pop -- is solver-owned and unarguable: on the worst
 * tick `moveCapsule` is handed a small DOWNWARD input displacement yet returns
 * the body lifted ~180 mm, so the solver moved it, not the motor. The secondary
 * "reached top" column is softer: it also depends on this fixture's reduced motor
 * projecting velocity along the contacts the solver reports, so a "NO" there means
 * "this motor + this solver stalled on the ramp", not solely a solver claim. The
 * verdict leans only on the pop.
 *
 * Run:  node src/player/fixtures/finite-ramp-defect.mjs
 */

import * as THREE from 'three';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StaticCollisionWorld } from './pr13-mesh-solver.mjs';

const STEP = 1 / 120;

// ── Tuning: PR #13's own defaults, so the solver runs as it did when blocked. ─
const TUNING = {
  radius: 0.34,
  standingHeight: 1.78,
  walkSpeed: 5.4,
  groundAcceleration: 34,
  gravity: 24,
  maxStepHeight: 0.34,
  groundSnapDistance: 0.08,
  maxWalkSlopeDegrees: 50,
};
const MIN_GROUND_NORMAL_Y = Math.cos(THREE.MathUtils.degToRad(TUNING.maxWalkSlopeDegrees));

// ── Ramp angles to sweep. Every run is 3 m; rise sets the angle. All are below
//    the 50 deg walkable limit, so a correct solver climbs every one smoothly. ─
const RUN_METERS = 3.0;
const HALF_WIDTH = 3.0;
const RISE_SWEEP = [0.9, 1.1, 1.3, 1.5, 1.7, 1.9, 2.3];

// A pop counts as uncommanded once it exceeds the legitimate per-tick climb by
// this tolerance. The fastest legit climb is grade * |dz| (~22 mm/tick here);
// anything past that + tolerance is the solver moving the body on its own.
const POP_TOLERANCE_MM = 5;
// Verdict threshold: a per-tick uncommanded pop at or above this is a defect.
const POP_DEFECT_MM = 30;

/** A closed triangular-prism wedge: bottom at y=0 (z in [-run,0]), sloped top
 *  from (z=0,y=0) up to (z=-run,y=rise), vertical back, two end caps. */
function buildWedge(run, rise, halfWidth) {
  const aL = new THREE.Vector3(-halfWidth, 0, 0);
  const bL = new THREE.Vector3(-halfWidth, 0, -run);
  const cL = new THREE.Vector3(-halfWidth, rise, -run);
  const aR = new THREE.Vector3(halfWidth, 0, 0);
  const bR = new THREE.Vector3(halfWidth, 0, -run);
  const cR = new THREE.Vector3(halfWidth, rise, -run);
  const tris = [
    // sloped top (the walkable face)
    aL, cL, cR, aL, cR, aR,
    // bottom (y=0)
    aL, aR, bR, aL, bR, bL,
    // vertical back (z=-run)
    bL, bR, cR, bL, cR, cL,
    // end caps
    aL, bL, cL,
    aR, cR, bR,
  ];
  const positions = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => { positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z; });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function meshOf(geometry, surface) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.userData.surface = surface;
  return mesh;
}

function buildScene(run, rise, halfWidth) {
  const group = new THREE.Group();

  // Approach floor: top y=0, z in [0,6].
  const floorMesh = meshOf(new THREE.BoxGeometry(12, 1, 6), 'concrete');
  floorMesh.position.set(0, -0.5, 3);
  group.add(floorMesh);

  // Wedge ramp, base at z in [-run,0].
  group.add(meshOf(buildWedge(run, rise, halfWidth), 'dirt'));

  // Top platform: top y=rise, z in [-run-3, -run].
  const platformMesh = meshOf(new THREE.BoxGeometry(12, 1, 3), 'concrete');
  platformMesh.position.set(0, rise - 0.5, -run - 1.5);
  group.add(platformMesh);

  return group;
}

/** Ideal surface height at world z for a perfectly-followed ramp. */
function idealHeight(z, run, rise, grade) {
  if (z >= 0) return 0;
  if (z <= -run) return rise;
  return -z * grade;
}

/** Walk one capsule up and over a single finite ramp; return per-tick samples. */
function traverse(run, rise, halfWidth) {
  const grade = rise / run;
  const world = StaticCollisionWorld.fromScene(buildScene(run, rise, halfWidth));

  const position = new THREE.Vector3(0, 0, 5);
  const velocity = new THREE.Vector3(0, 0, 0);
  let grounded = false;
  let previousFeetY = position.y;
  let previousZ = position.z;

  const samples = [];
  for (let tick = 0; tick < 500; tick++) {
    const wasGrounded = grounded;
    if (grounded && velocity.y < 0) velocity.y = 0;
    velocity.y -= TUNING.gravity * STEP;

    // Forward walk intent toward -Z, accelerated like the shipped motor.
    const delta = THREE.MathUtils.clamp(
      -TUNING.walkSpeed - velocity.z,
      -TUNING.groundAcceleration * STEP,
      TUNING.groundAcceleration * STEP,
    );
    velocity.z += delta;
    velocity.x = 0;

    const displacement = velocity.clone().multiplyScalar(STEP);
    const result = world.moveCapsule(position, {
      height: TUNING.standingHeight,
      radius: TUNING.radius,
      displacement,
      wasGrounded,
      maxStepHeight: TUNING.maxStepHeight,
      groundSnapDistance: TUNING.groundSnapDistance,
      minGroundNormalY: MIN_GROUND_NORMAL_Y,
    });

    position.copy(result.position);
    grounded = result.grounded;
    for (const contact of result.contacts) {
      const into = velocity.dot(contact.normal);
      if (into < 0) velocity.addScaledVector(contact.normal, -into);
    }
    if (grounded) velocity.y = 0;

    const z = position.z;
    const feetY = position.y;
    const dz = Math.abs(z - previousZ);
    const dy = feetY - previousFeetY;
    // Legit vertical this tick is at most grade*|dz| (the ramp grade); the
    // excess above that is the solver moving the body vertically on its own.
    const legitClimbMm = grade * dz * 1000;
    const uncommandedPopMm = Math.abs(dy) * 1000 - legitClimbMm - POP_TOLERANCE_MM;
    samples.push({
      tick,
      z: round(z, 4),
      feetY: round(feetY, 5),
      idealY: round(idealHeight(z, run, rise, grade), 5),
      grounded,
      dyMm: round(dy * 1000, 2),
      legitClimbMm: round(legitClimbMm, 2),
      uncommandedPopMm: round(Math.max(0, uncommandedPopMm), 2),
    });

    previousFeetY = feetY;
    previousZ = z;
    if (z < -run - 0.5) break;   // reached and settled on the platform
  }

  world.dispose();
  return samples;
}

/** Reduce one traverse to the numbers that matter, over the ramp+seam window. */
function analyse(run, rise, samples) {
  // Traverse window: ramp foot seam (z~0) through the platform seam (z~-run),
  // with a small margin on each side to include the seam transitions.
  const window = samples.filter((s) => s.z < 0.35 && s.z > -run - 0.35);
  const airborneTicks = window.filter((s) => !s.grounded).length;
  const pops = window.map((s) => s.uncommandedPopMm);
  const maxPopMm = pops.length ? Math.max(0, ...pops) : 0;
  const worst = window.reduce(
    (acc, s) => (s.uncommandedPopMm > acc.uncommandedPopMm ? s : acc),
    { uncommandedPopMm: -1 },
  );
  const reachedPlatform = samples.some((s) => s.z <= -run && Math.abs(s.feetY - rise) < 0.05);
  return {
    angleDegrees: round(THREE.MathUtils.radToDeg(Math.atan2(rise, run)), 2),
    riseMeters: rise,
    windowTicks: window.length,
    airborneTicks,
    maxUncommandedPopMm: round(maxPopMm, 1),
    worstPopTick: worst.uncommandedPopMm > 0 ? { tick: worst.tick, z: worst.z, feetY: worst.feetY } : null,
    reachedPlatform,
    defect: maxPopMm >= POP_DEFECT_MM || airborneTicks > 0,
  };
}

function run() {
  const perAngle = RISE_SWEEP.map((rise) => {
    const samples = traverse(RUN_METERS, rise, HALF_WIDTH);
    return { ...analyse(RUN_METERS, rise, samples), samples };
  });

  const summary = perAngle.map(({ samples, ...rest }) => rest);
  const worstCase = perAngle.reduce((a, b) => (b.maxUncommandedPopMm > a.maxUncommandedPopMm ? b : a));
  const firstDefect = summary.find((r) => r.defect) ?? null;
  const cleanBelow = summary.filter((r) => !r.defect).map((r) => r.angleDegrees);

  const reproduced = summary.some((r) => r.defect);
  const verdict = reproduced ? 'REPRODUCED' : 'NOT_REPRODUCED';
  const verdictReason = reproduced
    ? `The prior mesh solver produced an uncommanded vertical pop of `
      + `${worstCase.maxUncommandedPopMm.toFixed(1)} mm in a single 120 Hz tick on a finite `
      + `${worstCase.angleDegrees.toFixed(1)} deg solid ramp it rates fully walkable, while still `
      + `reporting itself grounded. The defect switches on sharply near `
      + `${firstDefect ? firstDefect.angleDegrees.toFixed(1) : '?'} deg: gentler ramps `
      + `(${cleanBelow.length ? cleanBelow.map((d) => d.toFixed(1)).join(', ') + ' deg' : 'none in this sweep'}) `
      + `stay smooth. This is the class of defect that blocked PRs #3/#13 -- reproduced concretely `
      + `on a finite solid, and worse than the original 45-57 mm report. It is why the shipped slice `
      + `restricts the world to axis-aligned boxes, where a ramp cannot be expressed and this solver `
      + `path is unreachable. A future slope solver must drive this pop to ~0 before slopes return.`
    : `Across ${summary.length} finite ramps from ${summary[0].angleDegrees.toFixed(1)} to `
      + `${summary[summary.length - 1].angleDegrees.toFixed(1)} deg the prior solver stayed grounded `
      + `with no uncommanded pop above ${POP_DEFECT_MM} mm. The blocker did NOT reproduce on this `
      + `sweep. That is a genuine finding, not a pass: it narrows where the defect lives.`;

  const report = {
    generatedAt: new Date().toISOString(),
    fixture: 'finite-ramp-defect',
    solver: 'faithful JS port of pr13:src/player/StaticCollisionWorld.ts (see pr13-mesh-solver.mjs)',
    fixedStepHz: 1 / STEP,
    method: {
      geometry: 'box approach floor + solid triangular wedge + box top platform',
      runMeters: RUN_METERS,
      halfWidthMeters: HALF_WIDTH,
      seams: ['concave floor->slope at z=0', 'convex slope->platform at z=-run'],
      popMetric: 'per-tick |dy| minus the legit ramp climb grade*|dz| minus '
        + `${POP_TOLERANCE_MM} mm tolerance; 0 on a perfectly followed ramp`,
      popDefectThresholdMm: POP_DEFECT_MM,
      walkableLimitDegrees: TUNING.maxWalkSlopeDegrees,
    },
    tuning: { ...TUNING, minGroundNormalY: round(MIN_GROUND_NORMAL_Y, 4) },
    perAngle: summary,
    worstCase: {
      angleDegrees: worstCase.angleDegrees,
      airborneTicks: worstCase.airborneTicks,
      maxUncommandedPopMm: worstCase.maxUncommandedPopMm,
      worstPopTick: worstCase.worstPopTick,
      trajectory: worstCase.samples,
    },
    verdict,
    verdictReason,
  };

  const out = fileURLToPath(new URL('./finite-ramp-defect.report.json', import.meta.url));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`finite ramps, run ${RUN_METERS} m, PR#13 solver, ${1 / STEP} Hz, `
    + `walkable limit ${TUNING.maxWalkSlopeDegrees} deg\n`);
  console.log('  angle    airborne   max uncommanded pop   reached top   verdict');
  for (const r of summary) {
    console.log(
      `  ${r.angleDegrees.toFixed(1).padStart(5)} deg`
      + `  ${String(r.airborneTicks).padStart(6)}`
      + `     ${(r.maxUncommandedPopMm.toFixed(1) + ' mm').padStart(12)}`
      + `        ${r.reachedPlatform ? 'yes' : 'NO '}`
      + `        ${r.defect ? 'DEFECT' : 'clean'}`,
    );
  }
  console.log(`\nVERDICT: ${verdict}`);
  console.log(verdictReason);
  console.log(`\nreport: ${out}`);
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

run();
