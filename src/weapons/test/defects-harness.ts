/**
 * Fail-before / pass-after fixtures for the three named weapon defects in #37
 * (parent #32, draft #20). Each test measures a behavioural quantity and asserts
 * the corrected value. Against the vendored #20 source every test FAILS; after
 * the three fixes every test PASSES. The methodology mirrors recoil-harness.ts:
 * this page runs in the browser through Vite and publishes a JSON result that
 * run-defects.mjs reads with Playwright.
 *
 *  1. instancedNormal   — impact normal on an InstancedMesh must include the
 *                         per-instance transform (Ballistics).
 *  2. fixedStepSpread    — movement spread must be identical across render rates
 *                         for identical input (WeaponSystem gameplay on the
 *                         fixed step, not the render loop).
 *  3. splitRng           — consuming cosmetic randomness must not perturb the
 *                         gameplay shot sequence, so a visuals-suppressed capture
 *                         fires the same pattern as live play (WeaponSystem RNG).
 */

import * as THREE from 'three';
import { EventBusImpl } from '../../core/bus.js';
import { Events } from '../../core/contracts.js';
import type { EngineContext, InputState, QualityTier } from '../../core/contracts.js';
import { HitscanBallistics } from '../Ballistics.js';
import type { BallisticShot } from '../Ballistics.js';
import { WeaponSystem } from '../WeaponSystem.js';
import { DUSKLINE_A7 } from '../WeaponConfig.js';
import type { BulletImpactPayload, WeaponFiredPayload } from '../events.js';

const FIXED_STEP = 1 / 120;
const DEG = 180 / Math.PI;
const RENDER_RATES = [30, 60, 144, 240] as const;

interface DefectOutcome {
  readonly name: string;
  readonly pass: boolean;
  readonly failures: string[];
  readonly detail: Record<string, unknown>;
}

interface HarnessResult {
  status: 'passed' | 'failed' | 'collection-error';
  collectionErrors: string[];
  defects: DefectOutcome[];
}

function makeInput(): InputState {
  return {
    move: { x: 0, y: 0 },
    look: { x: 0, y: 0 },
    jump: false,
    crouch: false,
    sprint: false,
    fire: false,
    aim: false,
    reload: false,
    pressed: () => false,
  };
}

/** Minimal EngineContext. WeaponSystem reads scene, camera, bus and input only. */
function makeContext(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  bus: EventBusImpl,
  input: InputState,
): EngineContext {
  return {
    scene,
    camera,
    renderer: {} as THREE.WebGLRenderer,
    time: 0,
    input,
    bus,
    quality: 'ultra' as QualityTier,
    get: () => undefined,
  };
}

function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 2000);
  camera.rotation.order = 'YXZ';
  camera.updateMatrixWorld(true);
  return camera;
}

// ── Defect 1 ────────────────────────────────────────────────────────────────
// One InstancedMesh, its single instance rotated 40° about Y. A plane's local
// normal is +Z; the instance's world normal is that vector rotated 40°. A ray
// straight down −Z hits the instance centre. The emitted impact normal must
// equal the instance's world normal, not the un-transformed geometry normal.
function testInstancedNormal(): DefectOutcome {
  const failures: string[] = [];
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(4, 4);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const instanced = new THREE.InstancedMesh(geometry, material, 1);
  const angle = 40 / DEG;
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, angle, 0));
  instanced.setMatrixAt(
    0,
    new THREE.Matrix4().compose(new THREE.Vector3(0, 0, -3), quaternion, new THREE.Vector3(1, 1, 1)),
  );
  instanced.instanceMatrix.needsUpdate = true;
  instanced.userData.ballisticCollider = true;
  instanced.userData.surface = 'metal';
  scene.add(instanced);
  scene.updateMatrixWorld(true);

  const bus = new EventBusImpl();
  let impact: BulletImpactPayload | null = null;
  bus.on<BulletImpactPayload>(Events.BulletImpact, (payload) => { impact = payload; });

  // random() → 0 removes all cone deviation: radius = sqrt(0) = 0.
  const ballistics = new HitscanBallistics(DUSKLINE_A7, scene, bus, () => 0);
  const shot: BallisticShot = {
    cameraOrigin: new THREE.Vector3(0, 0, 2),
    muzzleOrigin: new THREE.Vector3(0, 0, 2),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    recoilPitch: 0,
    recoilYaw: 0,
    spread: 0,
    ammo: 30,
  };
  ballistics.fire(shot);

  const expected = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
  const settled = impact as BulletImpactPayload | null;
  if (!settled) {
    failures.push('the ray did not resolve against the instanced collider');
  }
  const normal = settled ? settled.normal.clone() : new THREE.Vector3();
  const errorDeg = settled ? normal.angleTo(expected) * DEG : Number.NaN;
  if (settled && !(errorDeg < 0.5)) {
    failures.push(
      `impact normal is ${errorDeg.toFixed(3)}° from the instance world normal; `
        + 'the per-instance transform was not applied',
    );
  }

  geometry.dispose();
  material.dispose();
  instanced.dispose();
  return {
    name: 'instancedNormal',
    pass: failures.length === 0,
    failures,
    detail: {
      instanceRotationDeg: 40,
      measuredNormal: normal.toArray().map((v) => Number(v.toFixed(5))),
      expectedNormal: expected.toArray().map((v) => Number(v.toFixed(5))),
      normalErrorDeg: Number.isNaN(errorDeg) ? null : Number(errorDeg.toFixed(4)),
      material: settled ? settled.material : null,
    },
  };
}

// ── Defect 2 ────────────────────────────────────────────────────────────────
// Drive the real WeaponSystem through a faithful accumulator loop at several
// render rates with identical input (full strafe from rest + hip fire). The
// fire schedule is already fixed-step; the only quantity that can differ across
// render rates is the movement speed that feeds the spread cone. We record two
// gameplay quantities per shot: the spread magnitude, and the world point the
// round lands on a fixed wall. The landing point is aimPoint = cameraOrigin +
// (aim+recoil+cone)·range intersected with the wall; it depends only on the
// camera and the gameplay cone, NOT on the cosmetic viewmodel muzzle position,
// so it isolates the gameplay result from presentation muzzle parallax.
interface RateShot {
  spread: number;
  dir: THREE.Vector3;
  impact: THREE.Vector3 | null;
}

function runWeaponAtRate(renderHz: number, totalTime: number): RateShot[] {
  const scene = new THREE.Scene();
  // A wall 30 m down −Z (the camera's forward). Every round lands on it, so the
  // BulletImpact point is the gameplay aimPoint, free of muzzle parallax.
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(40, 40, 1),
    new THREE.MeshBasicMaterial(),
  );
  wall.position.set(0, 0, -30);
  wall.userData.ballisticCollider = true;
  wall.updateMatrixWorld(true);
  scene.add(wall);

  const camera = makeCamera();
  const bus = new EventBusImpl();
  const input = makeInput();
  input.move.x = 1;
  input.fire = true;
  const weapon = new WeaponSystem(DUSKLINE_A7);
  const ctx = makeContext(scene, camera, bus, input);
  weapon.init(ctx);

  const shots: RateShot[] = [];
  bus.on<WeaponFiredPayload>(Events.WeaponFired, (payload) => {
    shots.push({ spread: payload.spread, dir: payload.direction.clone(), impact: null });
  });
  bus.on<BulletImpactPayload>(Events.BulletImpact, (payload) => {
    const last = shots[shots.length - 1];
    if (last && last.impact === null) last.impact = payload.point.clone();
  });

  const dt = 1 / renderHz;
  const frames = Math.round(totalTime / dt);
  let accumulator = 0;
  for (let frame = 0; frame < frames; frame++) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 8) {
      weapon.fixedUpdate(FIXED_STEP, ctx);
      accumulator -= FIXED_STEP;
      steps++;
    }
    weapon.update({ dt, elapsed: (frame + 1) * dt, frame, alpha: accumulator / FIXED_STEP }, ctx);
  }
  weapon.dispose();
  return shots;
}

function testFixedStepSpread(): DefectOutcome {
  const failures: string[] = [];
  const totalTime = 0.5;
  const runs = new Map<number, RateShot[]>();
  for (const hz of RENDER_RATES) runs.set(hz, runWeaponAtRate(hz, totalTime));

  const reference = runs.get(240)!;
  const perRate: Record<string, unknown> = {};
  for (const hz of RENDER_RATES) {
    const run = runs.get(hz)!;
    if (run.length !== reference.length) {
      failures.push(`${hz} Hz fired ${run.length} shots; 240 Hz fired ${reference.length}`);
    }
    const count = Math.min(run.length, reference.length);
    let maxSpreadDiffDeg = 0;
    let maxDirDiffDeg = 0;
    let maxImpactDiff = 0;
    for (let i = 0; i < count; i++) {
      maxSpreadDiffDeg = Math.max(maxSpreadDiffDeg, Math.abs(run[i].spread - reference[i].spread) * DEG);
      maxDirDiffDeg = Math.max(maxDirDiffDeg, run[i].dir.angleTo(reference[i].dir) * DEG);
      const a = run[i].impact;
      const b = reference[i].impact;
      if (a && b) maxImpactDiff = Math.max(maxImpactDiff, a.distanceTo(b));
    }
    perRate[`${hz}Hz`] = {
      shots: run.length,
      maxSpreadDiffDeg: Number(maxSpreadDiffDeg.toFixed(6)),
      maxDirDiffDeg: Number(maxDirDiffDeg.toFixed(6)),
      maxImpactDiffMeters: Number(maxImpactDiff.toExponential(3)),
      spreadSequenceDeg: run.map((s) => Number((s.spread * DEG).toFixed(5))),
    };
    // The spread cone is a pure fixed-step quantity now, so it must agree to
    // 1e-6°: exact fixed-step agreement passes, render-rate drift fails.
    if (maxSpreadDiffDeg > 1e-6) {
      failures.push(`${hz} Hz spread drifts ${maxSpreadDiffDeg.toFixed(6)}° from 240 Hz for identical input`);
    }
    // The landing point is the gameplay outcome. 1e-4 m at 30 m range is < 2e-4°,
    // far tighter than the 0.03–0.12° render-rate drift the defect produces.
    if (maxImpactDiff > 1e-4) {
      failures.push(`${hz} Hz bullet lands ${maxImpactDiff.toExponential(3)} m from the 240 Hz point for identical input`);
    }
  }

  return {
    name: 'fixedStepSpread',
    pass: failures.length === 0,
    failures,
    detail: { totalTimeSeconds: totalTime, perRenderRate: perRate },
  };
}

// ── Defect 3 ────────────────────────────────────────────────────────────────
// A visuals-suppressed capture and a live (visuals-on) burst, both ADS, both
// from the same reseed, must fire the same gameplay direction sequence. If one
// RNG stream drives both gameplay and cosmetics, the cosmetic draws in live play
// shift every shot after the first, so the recorded capture is not what plays.
function testSplitRng(): DefectOutcome {
  const failures: string[] = [];
  const scene = new THREE.Scene();
  const camera = makeCamera();
  const bus = new EventBusImpl();
  const input = makeInput();
  const weapon = new WeaponSystem(DUSKLINE_A7);
  const ctx = makeContext(scene, camera, bus, input);
  weapon.init(ctx);

  const captured: THREE.Vector3[] = [];
  let stop = bus.on<WeaponFiredPayload>(Events.WeaponFired, (p) => captured.push(p.direction.clone()));
  weapon.capture('shot-15'); // 15 ADS shots, visuals suppressed, RNG reseeded
  stop();

  const live: THREE.Vector3[] = [];
  stop = bus.on<WeaponFiredPayload>(Events.WeaponFired, (p) => live.push(p.direction.clone()));
  weapon.capture('hip'); // reset + reseed
  weapon.resume();
  input.aim = true;
  input.fire = false;
  for (let i = 0; i < 40; i++) weapon.fixedUpdate(FIXED_STEP, ctx); // settle ADS to 1, no fire, no RNG draw
  // Pose the viewmodel to the identical ADS / elapsed-0 / recoil-0 state the
  // suppressed capture uses, so the muzzle origin (and its parallax) is the same
  // in both runs. Without this the viewmodel stays hip-posed and shot 1 would
  // differ by muzzle geometry alone — a confound that has nothing to do with RNG.
  // A single elapsed-0 render frame draws no randomness.
  weapon.update({ dt: FIXED_STEP, elapsed: 0, frame: 0, alpha: 0 }, ctx);
  input.fire = true;
  let guard = 0;
  while (live.length < 15 && guard++ < 400) weapon.fixedUpdate(FIXED_STEP, ctx); // fire, visuals ON
  input.fire = false;
  stop();
  weapon.dispose();

  if (captured.length !== 15) failures.push(`capture produced ${captured.length}/15 shots`);
  if (live.length !== 15) failures.push(`live burst produced ${live.length}/15 shots`);

  const count = Math.min(captured.length, live.length);
  const perShotDeg: number[] = [];
  let maxDiffDeg = 0;
  for (let i = 0; i < count; i++) {
    const diff = captured[i].angleTo(live[i]) * DEG;
    perShotDeg.push(Number(diff.toFixed(6)));
    maxDiffDeg = Math.max(maxDiffDeg, diff);
  }
  if (maxDiffDeg > 1e-6) {
    const divergent = perShotDeg.filter((d) => d > 1e-6).length;
    failures.push(
      `${divergent}/${count} shots diverge (max ${maxDiffDeg.toFixed(5)}°): cosmetic randomness `
        + 'perturbs the gameplay shot sequence',
    );
  }

  return {
    name: 'splitRng',
    pass: failures.length === 0,
    failures,
    detail: {
      capturedShots: captured.length,
      liveShots: live.length,
      maxDiffDeg: Number(maxDiffDeg.toFixed(6)),
      perShotDiffDeg: perShotDeg,
    },
  };
}

function run(): HarnessResult {
  const result: HarnessResult = { status: 'passed', collectionErrors: [], defects: [] };
  try {
    result.defects.push(testInstancedNormal());
    result.defects.push(testFixedStepSpread());
    result.defects.push(testSplitRng());
  } catch (error) {
    result.collectionErrors.push(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  }
  result.status = result.collectionErrors.length > 0
    ? 'collection-error'
    : result.defects.every((d) => d.pass) ? 'passed' : 'failed';
  return result;
}

const result = run();
(window as unknown as { __DEFECTS_RESULT__: HarnessResult }).__DEFECTS_RESULT__ = result;
const target = document.querySelector('#result');
if (target) target.textContent = JSON.stringify(result, null, 2);
