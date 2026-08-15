/**
 * Regression witness: the present bracket that dresses the camera with view
 * effects must restore the true pose EVEN WHEN THE DRAW THROWS.
 *
 * The harness presents a frame as:
 *
 *     player.applyViewEffects();      // save true pose, add bob/dip/step/roll
 *     try { render.render(); }        // draw the dressed frame
 *     finally { player.restoreView(); }   // put the true pose back
 *
 * The defect this guards against (found in review of PR #40): without the
 * try/finally, a throwing `render.render()` skips `restoreView()`, so
 * `viewApplied` stays true and the saved pose is stale. The NEXT frame's
 * `applyViewEffects()` early-returns (already "applied"), its `restoreView()`
 * then copies last frame's saved position over the current true pose, and every
 * observer that reads `window.engine.camera` between frames — AI, networking,
 * this project's own verify-slice — sees a corrupted position.
 *
 * This fixture ports PlayerSystem.applyViewEffects / restoreView verbatim
 * (PlayerSystem.ts) and drives both the unsafe and the safe present bracket
 * over two frames — a throwing frame N and a clean frame N+1 at a different true
 * position — using real three cameras. It asserts the SHIPPED (safe) bracket
 * always restores the true pose, and that the UNSAFE bracket demonstrably
 * corrupts the next frame (so the test has teeth rather than passing vacuously).
 *
 * Run:  node src/player/fixtures/view-restore-on-throw.mjs
 * Exit: 0 all invariants hold; 1 a regression is present.
 */

import * as THREE from 'three';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EYE_HEIGHT = 1.66;
const TOL = 1e-6;

/**
 * Faithful port of the view-effect bracket carried by PlayerSystem: update()
 * writes the true pose and records the cosmetic offsets; applyViewEffects /
 * restoreView are copied line-for-line from PlayerSystem.ts.
 */
class ViewEffectRig {
  constructor() {
    this.camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 2000);
    this.camera.rotation.order = 'YXZ';
    this.cameraRight = new THREE.Vector3();
    this.savedCameraPosition = new THREE.Vector3();
    this.viewBobX = 0;
    this.viewOffsetY = 0;
    this.viewRoll = 0;
    this.viewApplied = false;
  }

  // Mirrors PlayerSystem.update(): authoritative true pose is written to the
  // shared camera; the cosmetic offsets are recorded but NOT baked in.
  writeTruePose(feet, yaw, pitch, offsets) {
    this.cameraRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this.viewBobX = offsets.bobX;
    this.viewOffsetY = offsets.bobY + offsets.landing + offsets.step;
    this.viewRoll = offsets.roll;
    this.camera.position.copy(feet);
    this.camera.position.y += EYE_HEIGHT;
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  // --- verbatim from PlayerSystem.ts -------------------------------------
  applyViewEffects() {
    const camera = this.camera;
    if (!camera || this.viewApplied) return;
    this.savedCameraPosition.copy(camera.position);
    camera.position.addScaledVector(this.cameraRight, this.viewBobX);
    camera.position.y += this.viewOffsetY;
    camera.rotation.z = this.viewRoll;
    camera.updateMatrixWorld(true);
    this.viewApplied = true;
  }

  restoreView() {
    const camera = this.camera;
    if (!camera || !this.viewApplied) return;
    camera.position.copy(this.savedCameraPosition);
    camera.rotation.z = 0;
    camera.updateMatrixWorld(true);
    this.viewApplied = false;
  }
  // -----------------------------------------------------------------------
}

// The two present brackets: the pre-fix harness (no finally) and the shipped one.
function presentUnsafe(rig, render) {
  rig.applyViewEffects();
  render();
  rig.restoreView();
}

function presentSafe(rig, render) {
  rig.applyViewEffects();
  try {
    render();
  } finally {
    rig.restoreView();
  }
}

const throwingDraw = () => { throw new Error('injected present failure'); };
const okDraw = () => {};

// Two frames: a throwing frame N, then a clean frame N+1 at a DIFFERENT true
// position (the player walked -0.5 m in z), so a stale restore is unmistakable.
const FEET_N = new THREE.Vector3(0, 0, 6);
const FEET_N1 = new THREE.Vector3(0, 0, 5.5);
const OFF_N = { bobX: 0.02, bobY: 0.05, landing: -0.03, step: 0.0, roll: 0.03 };
const OFF_N1 = { bobX: 0.018, bobY: 0.04, landing: 0.0, step: 0.0, roll: 0.028 };

const truePose = (feet, yaw, pitch) => ({
  pos: new THREE.Vector3(feet.x, feet.y + EYE_HEIGHT, feet.z),
  rz: 0,
  yaw,
  pitch,
});

function run(present) {
  const rig = new ViewEffectRig();

  // Frame N — the draw throws.
  rig.writeTruePose(FEET_N, 0, 0, OFF_N);
  let threw = false;
  try {
    present(rig, throwingDraw);
  } catch {
    threw = true; // the presenter is expected to propagate the draw failure
  }
  const afterThrow = {
    pos: rig.camera.position.clone(),
    rz: rig.camera.rotation.z,
    viewApplied: rig.viewApplied,
  };

  // Frame N+1 — a normal draw at a new true position.
  rig.writeTruePose(FEET_N1, 0, 0, OFF_N1);
  present(rig, okDraw);
  const afterNext = {
    pos: rig.camera.position.clone(),
    rz: rig.camera.rotation.z,
    viewApplied: rig.viewApplied,
  };

  return { threw, afterThrow, afterNext };
}

const expectedTrueN = truePose(FEET_N, 0, 0);     // (0, 1.66, 6)
const expectedTrueN1 = truePose(FEET_N1, 0, 0);   // (0, 1.66, 5.5)

const safe = run(presentSafe);
const unsafe = run(presentUnsafe);

const near = (a, b) => a.distanceTo(b) <= TOL;

// The property we ship: the safe bracket restores the true pose on the throwing
// frame AND leaves the next frame's true pose intact (no stale carry-over).
const checks = [
  {
    name: 'safe: true pose N restored after the draw throws',
    pass: near(safe.afterThrow.pos, expectedTrueN.pos)
      && Math.abs(safe.afterThrow.rz) <= TOL
      && safe.afterThrow.viewApplied === false,
    detail: `camera=${fmt(safe.afterThrow.pos)} rz=${safe.afterThrow.rz.toFixed(4)} `
      + `expected=${fmt(expectedTrueN.pos)}`,
  },
  {
    name: 'safe: next frame shows true pose N+1 (no stale restore)',
    pass: near(safe.afterNext.pos, expectedTrueN1.pos)
      && Math.abs(safe.afterNext.rz) <= TOL,
    detail: `camera=${fmt(safe.afterNext.pos)} expected=${fmt(expectedTrueN1.pos)}`,
  },
  {
    // Teeth: the unsafe bracket must actually corrupt frame N+1, otherwise the
    // safe checks above would prove nothing.
    name: 'teeth: unsafe bracket corrupts frame N+1 with the stale pose',
    pass: near(unsafe.afterNext.pos, expectedTrueN.pos)
      && !near(unsafe.afterNext.pos, expectedTrueN1.pos),
    detail: `camera=${fmt(unsafe.afterNext.pos)} stale=${fmt(expectedTrueN.pos)} `
      + `true=${fmt(expectedTrueN1.pos)} error=`
      + `${unsafe.afterNext.pos.distanceTo(expectedTrueN1.pos).toFixed(3)} m`,
  },
];

function fmt(v) {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
}

const allPass = checks.every((c) => c.pass);
const verdict = allPass ? 'RESTORED (exception-safe)' : 'REGRESSION';

console.log('present-bracket view-effect restore, two frames, real three cameras\n');
console.log('  result                                                          check');
for (const c of checks) {
  console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
  console.log(`        ${c.detail}`);
}
console.log(`\nVERDICT: ${verdict}`);
console.log(
  allPass
    ? 'The shipped (try/finally) present bracket restores the true camera pose\n'
      + 'even when the draw throws; the unsafe variant would have carried a stale\n'
      + 'pose into the next frame.'
    : 'The present bracket failed to restore the true camera pose on a throwing draw.',
);

const out = fileURLToPath(new URL('./view-restore-on-throw.report.json', import.meta.url));
writeFileSync(out, `${JSON.stringify({
  eyeHeight: EYE_HEIGHT,
  frames: {
    N: { feet: FEET_N.toArray(), offsets: OFF_N, expectedTrue: expectedTrueN.pos.toArray() },
    Nplus1: { feet: FEET_N1.toArray(), offsets: OFF_N1, expectedTrue: expectedTrueN1.pos.toArray() },
  },
  safe: {
    afterThrow: { pos: safe.afterThrow.pos.toArray(), rz: safe.afterThrow.rz, viewApplied: safe.afterThrow.viewApplied },
    afterNext: { pos: safe.afterNext.pos.toArray(), rz: safe.afterNext.rz },
  },
  unsafe: {
    afterThrow: { pos: unsafe.afterThrow.pos.toArray(), viewApplied: unsafe.afterThrow.viewApplied },
    afterNext: { pos: unsafe.afterNext.pos.toArray() },
  },
  checks: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
  verdict,
}, null, 2)}\n`);
console.log(`\nreport: ${out}`);

process.exit(allPass ? 0 : 1);
