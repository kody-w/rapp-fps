/**
 * In-browser CPU microbenchmark for the weapon subsystem (#37). The whole-frame
 * profiler cannot resolve the subsystem's own cost: per-frame CPU noise (~1 ms)
 * dwarfs the 0.25 ms budget. This measures ONLY weapon.fixedUpdate/update in the
 * same V8 the game runs in, excluding all rendering, so the number is the
 * subsystem's amortised per-rendered-frame CPU cost.
 *
 * A rendered frame at 60 Hz runs two 120 Hz fixed steps plus one render update,
 * so one "frame" here is 2×fixedUpdate + 1×update with the trigger held (the
 * hot path: cadence, recoil, spread and — on firing ticks — two hitscan
 * raycasts). Reported as the mean over large batches (performance.now() is too
 * coarse to time a single sub-microsecond frame) with a worst-batch figure.
 */

import * as THREE from 'three';
import { EventBusImpl } from '../../core/bus.js';
import { Events } from '../../core/contracts.js';
import type { EngineContext, InputState, QualityTier } from '../../core/contracts.js';
import { WeaponSystem } from '../WeaponSystem.js';
import { DUSKLINE_A7 } from '../WeaponConfig.js';

const FIXED_STEP = 1 / 120;
const BUDGET_MS = 0.25;

interface BenchResult {
  status: 'passed' | 'failed';
  meanFrameMs: number;
  worstBatchMeanFrameMs: number;
  budgetMs: number;
  pass: boolean;
  shotsFired: number;
  framesMeasured: number;
  batches: number;
  detail: Record<string, unknown>;
}

function makeInput(): InputState {
  return {
    move: { x: 0, y: 0 }, look: { x: 0, y: 0 },
    jump: false, crouch: false, sprint: false, fire: false, aim: false, reload: false,
    pressed: () => false,
  };
}

function makeContext(scene: THREE.Scene, camera: THREE.PerspectiveCamera, bus: EventBusImpl, input: InputState): EngineContext {
  return {
    scene, camera, renderer: {} as THREE.WebGLRenderer,
    time: 0, input, bus, quality: 'ultra' as QualityTier, get: () => undefined,
  };
}

function run(): BenchResult {
  const scene = new THREE.Scene();
  // A ballistic wall so firing ticks pay the real scene-mesh raycast cost.
  const wall = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 1), new THREE.MeshBasicMaterial());
  wall.position.set(0, 0, -25);
  wall.userData.ballisticCollider = true;
  wall.updateMatrixWorld(true);
  scene.add(wall);

  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 2000);
  camera.rotation.order = 'YXZ';
  camera.updateMatrixWorld(true);

  const bus = new EventBusImpl();
  const input = makeInput();
  input.move.x = 1;   // moving, so spread is live
  input.fire = true;  // trigger held: exercise the firing hot path
  // Unlimited magazine (as the stress dev page uses) keeps every measured frame
  // in the sustained-fire hot path — 720 RPM, so ~1 in 10 fixed steps pays the
  // two hitscan raycasts — rather than decaying to idle after the reserve runs out.
  const config = { ...DUSKLINE_A7, magazineSize: 1_000_000, reserveAmmo: 0 };
  const weapon = new WeaponSystem(config);
  const ctx = makeContext(scene, camera, bus, input);
  weapon.init(ctx);

  let shots = 0;
  bus.on(Events.WeaponFired, () => { shots++; });

  let elapsed = 0;
  let frameIndex = 0;
  const oneFrame = (): void => {
    weapon.fixedUpdate(FIXED_STEP, ctx);
    weapon.fixedUpdate(FIXED_STEP, ctx);
    weapon.update({ dt: 1 / 60, elapsed, frame: frameIndex, alpha: 0 }, ctx);
    elapsed += 1 / 60;
    frameIndex++;
  };

  // Warm up JIT and let ADS/spread reach steady state.
  for (let i = 0; i < 1000; i++) oneFrame();

  const BATCHES = 20;
  const FRAMES_PER_BATCH = 2000;
  const batchMeans: number[] = [];
  const startShots = shots;
  for (let b = 0; b < BATCHES; b++) {
    const t0 = performance.now();
    for (let i = 0; i < FRAMES_PER_BATCH; i++) oneFrame();
    const t1 = performance.now();
    batchMeans.push((t1 - t0) / FRAMES_PER_BATCH);
  }
  weapon.dispose();

  const framesMeasured = BATCHES * FRAMES_PER_BATCH;
  const meanFrameMs = batchMeans.reduce((a, c) => a + c, 0) / batchMeans.length;
  const worstBatchMeanFrameMs = Math.max(...batchMeans);
  const pass = worstBatchMeanFrameMs < BUDGET_MS;

  return {
    status: pass ? 'passed' : 'failed',
    meanFrameMs: Number(meanFrameMs.toFixed(6)),
    worstBatchMeanFrameMs: Number(worstBatchMeanFrameMs.toFixed(6)),
    budgetMs: BUDGET_MS,
    pass,
    shotsFired: shots - startShots,
    framesMeasured,
    batches: BATCHES,
    detail: {
      perFrame: '2×fixedUpdate + 1×update at 60 Hz, trigger held, moving',
      batchMeansMs: batchMeans.map((m) => Number(m.toFixed(6))),
      note: 'excludes all rendering; measures the weapon subsystem CPU only',
    },
  };
}

const result = run();
(window as unknown as { __BENCH_RESULT__: BenchResult }).__BENCH_RESULT__ = result;
// eslint-disable-next-line no-console
console.log('[bench]', JSON.stringify(result));
