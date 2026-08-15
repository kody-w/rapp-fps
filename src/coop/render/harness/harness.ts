/**
 * Real-WebGL harness for the co-op split-screen render library. — Refs #71
 *
 * Runs in a browser under a Vite dev server (see ./run.mjs). It builds a real
 * `THREE.WebGLRenderer`, one shared scene with a red slab on the left and a blue
 * slab on the right, and two DIFFERENTLY POSITIONED cameras — P1 facing the red
 * slab, P2 facing the blue slab — then drives the shipped `CoopRenderCoordinator`
 * and reads pixels back off the GPU to prove:
 *
 *   - slotIsolation: the top slot shows P1's red view, the bottom shows P2's
 *     blue view, and they differ; a negative control renders both slots through
 *     the SAME camera and confirms the read-back would have caught sameness.
 *   - seamTiling: with per-slot clear colours over an odd-height buffer, the
 *     centre column transitions from blue to red at exactly the planned split
 *     row with no sentinel-green gap; hand-broken gap and overlap plans are both
 *     detected, so the seam read-back is not trivially green.
 *   - gpuTrials: three trials of the two-view render at HALF device-pixel-ratio,
 *     each timed with `EXT_disjoint_timer_query_webgl2` exactly as the engine's
 *     FrameProfiler does. If the timer is unsupported or reports disjoint, the
 *     trial is marked UNVERIFIED — never estimated — matching profiler.ts.
 *
 * The result object is published on `window.__COOP_HARNESS__` for ./run.mjs.
 */

import * as THREE from 'three';
import { planCoopViewports, CoopRenderCoordinator } from '../index.js';
import type { CoopViewportPlan, RenderableCoopPlan, CoopSlot } from '../index.js';

const BUDGET_MS = 16.7;

interface TimerExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
  readonly QUERY_COUNTER_BITS_EXT: number;
}

interface HarnessSection {
  name: string;
  pass: boolean;
  detail: unknown;
}

interface TrialResult {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
  disjoint: boolean;
  underBudget: boolean | null;
}

interface HarnessResult {
  done: boolean;
  ok: boolean;
  meta: Record<string, unknown>;
  sections: HarnessSection[];
  gpu: {
    verdict: 'MEASURED' | 'UNVERIFIED';
    reason?: string;
    budgetMs: number;
    halfResBacking?: { width: number; height: number };
    trials: TrialResult[];
    allUnderBudget: boolean | null;
  };
  errors: string[];
}

type Channel = 'r' | 'g' | 'b';

const raf = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const quantile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(3);
};

function dominantChannel(pixel: Uint8Array, offset = 0): Channel {
  const r = pixel[offset];
  const g = pixel[offset + 1];
  const b = pixel[offset + 2];
  if (r >= g && r >= b) return 'r';
  if (g >= r && g >= b) return 'g';
  return 'b';
}

function readPixel(gl: WebGL2RenderingContext, x: number, y: number): Uint8Array {
  const out = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

/** Read the full 1-pixel-wide centre column and classify each backing row. */
function readColumn(gl: WebGL2RenderingContext, x: number, height: number): Channel[] {
  const buffer = new Uint8Array(height * 4);
  gl.readPixels(x, 0, 1, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
  const column: Channel[] = [];
  for (let row = 0; row < height; row++) column.push(dominantChannel(buffer, row * 4));
  return column;
}

/** A shared scene: red slab on the left (-x), blue slab on the right (+x). */
function buildScene(): {
  scene: THREE.Scene;
  emptyScene: THREE.Scene;
  cameras: [THREE.PerspectiveCamera, THREE.PerspectiveCamera];
} {
  const scene = new THREE.Scene();
  const redSlab = new THREE.Mesh(
    new THREE.BoxGeometry(4, 400, 400),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0, 0) }),
  );
  redSlab.position.set(-50, 0, 0);
  const blueSlab = new THREE.Mesh(
    new THREE.BoxGeometry(4, 400, 400),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 1) }),
  );
  blueSlab.position.set(50, 0, 0);
  scene.add(redSlab, blueSlab);
  scene.updateMatrixWorld(true);

  const p1 = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  p1.name = 'P1';
  p1.position.set(-2, 0, 0);
  p1.lookAt(-50, 0, 0);
  const p2 = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  p2.name = 'P2';
  p2.position.set(2, 0, 0);
  p2.lookAt(50, 0, 0);

  const emptyScene = new THREE.Scene();
  return { scene, emptyScene, cameras: [p1, p2] };
}

function main(): void {
  const result: HarnessResult = {
    done: false,
    ok: false,
    meta: {},
    sections: [],
    gpu: { verdict: 'UNVERIFIED', budgetMs: BUDGET_MS, trials: [], allUnderBudget: null },
    errors: [],
  };
  const publish = (): void => {
    (window as unknown as { __COOP_HARNESS__: HarnessResult }).__COOP_HARNESS__ = result;
  };
  const section = (name: string, pass: boolean, detail: unknown): void => {
    result.sections.push({ name, pass, detail });
  };
  publish();

  void (async () => {
    try {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        powerPreference: 'high-performance',
        stencil: false,
      });
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
      const counterBits = timer
        ? Number(gl.getQuery(timer.TIME_ELAPSED_EXT, timer.QUERY_COUNTER_BITS_EXT))
        : 0;
      result.meta = {
        threeRevision: THREE.REVISION,
        webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
        unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        timerExt: Boolean(timer),
        counterBits,
        devicePixelRatio: window.devicePixelRatio,
      };

      const { scene, emptyScene, cameras } = buildScene();
      const coordinator = new CoopRenderCoordinator();

      // ── slot isolation (even backing, real geometry) ────────────────────
      {
        const cssWidth = 640;
        const cssHeight = 360;
        const pixelRatio = 2; // backing 1280x720
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(cssWidth, cssHeight, false);
        const plan = planCoopViewports({ cssWidth, cssHeight, pixelRatio, players: 2 });
        if (!plan.renderable) {
          section('slotIsolation', false, { refused: plan.reason });
        } else {
          const [top, bottom] = plan.slots;
          const cx = Math.floor(plan.backing.width / 2);
          const topY = top.backing.y + Math.floor(top.backing.height / 2);
          const bottomY = bottom.backing.y + Math.floor(bottom.backing.height / 2);

          coordinator.renderCoop(plan, scene, cameras, renderer);
          const topPixel = readPixel(gl, cx, topY);
          const bottomPixel = readPixel(gl, cx, bottomY);
          const topChan = dominantChannel(topPixel);
          const bottomChan = dominantChannel(bottomPixel);
          const slotsDiffer = topChan !== bottomChan;

          // Negative control: same camera in both slots ⇒ both slots identical.
          coordinator.renderCoop(plan, scene, [cameras[0], cameras[0]], renderer);
          const ctrlTop = dominantChannel(readPixel(gl, cx, topY));
          const ctrlBottom = dominantChannel(readPixel(gl, cx, bottomY));
          const controlMatches = ctrlTop === ctrlBottom;

          const pass =
            topChan === 'r' && bottomChan === 'b' && slotsDiffer
            && controlMatches && ctrlTop === 'r';
          section('slotIsolation', pass, {
            topPixel: [...topPixel], bottomPixel: [...bottomPixel],
            topChan, bottomChan,
            control: { top: ctrlTop, bottom: ctrlBottom, sameCameraMatches: controlMatches },
          });
        }
      }

      // ── seam tiling (odd backing, per-slot clear colours) ───────────────
      {
        const cssWidth = 641;
        const cssHeight = 361;
        const pixelRatio = 1; // backing 641x361, odd height
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(cssWidth, cssHeight, false);
        const plan = planCoopViewports({ cssWidth, cssHeight, pixelRatio, players: 2 });
        if (!plan.renderable) {
          section('seamTiling', false, { refused: plan.reason });
        } else {
          const bh = plan.backing.height;
          const splitY = plan.slots[1].backing.height; // bottom height == split row
          const cx = Math.floor(plan.backing.width / 2);
          const red = new THREE.Color(1, 0, 0);
          const blue = new THREE.Color(0, 0, 1);
          const green = new THREE.Color(0, 1, 0);

          const paintSentinel = (): void => {
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, cssWidth, cssHeight);
            renderer.setScissor(0, 0, cssWidth, cssHeight);
            renderer.setClearColor(green, 1);
            renderer.clear(true, true, false);
          };

          // Correct plan: bottom→blue, top→red, no green survives, split at splitY.
          paintSentinel();
          coordinator.renderCoop(plan, emptyScene, cameras, renderer, { slotClearColors: [red, blue] });
          const column = readColumn(gl, cx, bh);
          const greenRows = column.filter((c) => c === 'g').length;
          const firstRed = column.indexOf('r');
          const lastBlue = column.lastIndexOf('b');
          const cleanTransition = lastBlue === splitY - 1 && firstRed === splitY;
          const correctPass = greenRows === 0 && cleanTransition;

          // Negative control — GAP: shrink bottom by one row; row splitY-1 stays green.
          const gapPlan = withBottomHeight(plan, splitY - 1);
          paintSentinel();
          coordinator.renderCoop(gapPlan, emptyScene, cameras, renderer, { slotClearColors: [red, blue] });
          const gapColumn = readColumn(gl, cx, bh);
          const gapDetected = gapColumn[splitY - 1] === 'g';

          // Negative control — OVERLAP: grow bottom by one row; it paints over row splitY.
          const overlapPlan = withBottomHeight(plan, splitY + 1);
          paintSentinel();
          coordinator.renderCoop(overlapPlan, emptyScene, cameras, renderer, { slotClearColors: [red, blue] });
          const overlapColumn = readColumn(gl, cx, bh);
          const overlapDetected = overlapColumn[splitY] === 'b'; // top row overwritten by bottom blue

          section('seamTiling', correctPass && gapDetected && overlapDetected, {
            splitY,
            backingHeight: bh,
            correct: { greenRows, firstRed, lastBlue, cleanTransition },
            gapControl: { rowChecked: splitY - 1, value: gapColumn[splitY - 1], gapDetected },
            overlapControl: { rowChecked: splitY, value: overlapColumn[splitY], overlapDetected },
          });
        }
      }

      // ── three half-resolution two-view GPU trials ───────────────────────
      await runGpuTrials(result, renderer, gl, timer, counterBits, scene, cameras, coordinator);

      const correctnessPass = result.sections.every((s) => s.pass);
      result.ok = correctnessPass && result.errors.length === 0;
      const log = document.getElementById('log');
      if (log) {
        log.textContent = `co-op render harness — ok=${result.ok}\n`
          + result.sections.map((s) => `  [${s.pass ? 'ok ' : 'BAD'}] ${s.name}`).join('\n')
          + `\n  gpu: ${result.gpu.verdict}`;
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
      result.ok = false;
    } finally {
      result.done = true;
      publish();
    }
  })();
}

/** Clone a renderable plan with the bottom band forced to a broken height. */
function withBottomHeight(plan: RenderableCoopPlan, height: number): CoopViewportPlan {
  const [top, bottom] = plan.slots;
  const pr = plan.pixelRatio;
  const brokenBottom: CoopSlot = {
    ...bottom,
    backing: { ...bottom.backing, height },
    css: { x: bottom.backing.x / pr, y: bottom.backing.y / pr, width: bottom.backing.width / pr, height: height / pr },
    aspect: bottom.backing.width / height,
  };
  return { ...plan, slots: [top, brokenBottom] };
}

async function runGpuTrials(
  result: HarnessResult,
  renderer: THREE.WebGLRenderer,
  gl: WebGL2RenderingContext,
  timer: TimerExt | null,
  counterBits: number,
  scene: THREE.Scene,
  cameras: readonly THREE.PerspectiveCamera[],
  coordinator: CoopRenderCoordinator,
): Promise<void> {
  // Half device-pixel-ratio: a 1920x1080 logical target renders into 960x540
  // backing pixels, split into two 960x270 views.
  const cssWidth = 1920;
  const cssHeight = 1080;
  const pixelRatio = 0.5;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(cssWidth, cssHeight, false);
  const plan = planCoopViewports({ cssWidth, cssHeight, pixelRatio, players: 2 });
  if (plan.renderable) {
    result.gpu.halfResBacking = { width: plan.backing.width, height: plan.backing.height };
  }

  if (!plan.renderable || !timer || counterBits === 0) {
    result.gpu.verdict = 'UNVERIFIED';
    result.gpu.reason = !plan.renderable
      ? `plan refused: ${plan.reason}`
      : 'EXT_disjoint_timer_query_webgl2 unavailable or zero counter bits';
    // Still exercise the two-view render so a broken draw would surface as an error.
    for (let i = 0; i < 4; i++) {
      coordinator.renderCoop(plan, scene, cameras, renderer);
      await raf();
    }
    return;
  }

  const framesPerTrial = 60;
  for (let trial = 0; trial < 3; trial++) {
    const samplesMs: number[] = [];
    const pending: WebGLQuery[] = [];
    let disjoint = false;
    gl.getParameter(timer.GPU_DISJOINT_EXT); // reset the disjoint epoch

    const drain = (): void => {
      while (pending.length > 0) {
        const query = pending[0];
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        const isDisjoint = Boolean(gl.getParameter(timer.GPU_DISJOINT_EXT));
        pending.shift();
        if (isDisjoint) {
          disjoint = true;
          gl.deleteQuery(query);
          continue;
        }
        const ns = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
        gl.deleteQuery(query);
        if (Number.isFinite(ns) && ns > 0) samplesMs.push(ns / 1_000_000);
      }
    };

    for (let i = 0; i < 8; i++) {
      coordinator.renderCoop(plan, scene, cameras, renderer);
      await raf();
    }
    for (let i = 0; i < framesPerTrial; i++) {
      const query = gl.createQuery();
      if (!query) break;
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      coordinator.renderCoop(plan, scene, cameras, renderer);
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push(query);
      await raf();
      drain();
    }
    let guard = 0;
    while (pending.length > 0 && guard < 600) {
      await raf();
      drain();
      guard++;
    }
    for (const leftover of pending) gl.deleteQuery(leftover);

    const median = quantile(samplesMs, 0.5);
    const p95 = quantile(samplesMs, 0.95);
    result.gpu.trials.push({
      samples: samplesMs.length,
      medianMs: median,
      p95Ms: p95,
      disjoint,
      underBudget: p95 === null ? null : p95 <= BUDGET_MS,
    });
  }

  const allMeasured = result.gpu.trials.length === 3
    && result.gpu.trials.every((t) => !t.disjoint && t.samples > 0 && t.p95Ms !== null);
  if (allMeasured) {
    result.gpu.verdict = 'MEASURED';
    result.gpu.allUnderBudget = result.gpu.trials.every((t) => t.underBudget === true);
  } else {
    result.gpu.verdict = 'UNVERIFIED';
    result.gpu.reason = 'a trial reported disjoint or produced no samples';
    result.gpu.allUnderBudget = null;
  }
}

main();
