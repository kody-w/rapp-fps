/**
 * Browser-free evidence for the horizontal split-screen render library. — Refs #71
 *
 * This module is the witness a reviewer reads instead of a summary. It exercises
 * the pure math and the coordinator with plain numbers, a real (Node-importable)
 * `THREE` for the camera/vector/colour maths, and a call-recording
 * {@link FakeRenderer}. There is no GPU, no DOM, no canvas. Every section marks
 * itself failed (and the runner exits non-zero) if a claim does not hold.
 *
 * The sections, and the exact defect each one would have caught:
 *
 *  1. singlePlayerFullscreen — 1 player fills the whole drawing buffer.
 *  2. horizontalSplitTiling — 2 stacked bands tile the buffer with no gap and no
 *     overlap across even, odd and fractional-DPR sizes; the extra odd row goes
 *     where documented; each rect survives THREE's round(css*pr) re-application.
 *  3. seamNegativeControl — the tiling oracle is NOT trivially green: a naive
 *     CSS-halving split and hand-built gap/overlap plans are all rejected.
 *  4. zeroSizeRefusal — zero, negative, NaN, Infinity and too-small-to-split
 *     sizes are refused as first-class values, never a NaN aspect.
 *  5. resizeDeterminism — a resize/DPR sequence recomputes deterministically;
 *     the planner is pure, so a second run is byte-identical.
 *  6. coordinatorSplit — the coordinator draws the ONE shared scene per camera
 *     under each slot's scissor, sets each camera's slot aspect, clears inside
 *     the scissor, and restores every renderer + camera value it touched.
 *  7. coordinatorRestoresOnThrow — a throwing draw still restores all state.
 *  8. isolationOracleControl — the slot-isolation oracle can fail (a corrupted
 *     record is rejected), so section 6's pass means something.
 *  9. singlePlayerCoordinator — the 1-player path draws once, full screen.
 * 10. coordinatorDeterminism — two identical coordinator runs record identically.
 * 11. refusalIsInert — a refused plan or a camera-count mismatch touches no state.
 */

import * as THREE from 'three';
import {
  planCoopViewports,
  checkExactTiling,
  CoopRenderCoordinator,
} from '../index.js';
import type {
  CoopViewportInput,
  CoopViewportPlan,
  RenderableCoopPlan,
  CoopSlot,
  PixelRect,
} from '../index.js';
import { FakeRenderer } from './fake-renderer.js';

type Expect = (condition: boolean, message: string) => void;

interface SectionResult {
  name: string;
  pass: boolean;
  failures: string[];
  detail?: unknown;
}

export interface EvidenceReport {
  library: string;
  threeRevision: string;
  ok: boolean;
  passed: number;
  total: number;
  failures: string[];
  sections: SectionResult[];
}

const EPS = 1e-9;
const rectArray = (r: PixelRect): [number, number, number, number] => [r.x, r.y, r.width, r.height];
const arraysEqual = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= EPS);

/** Backing width/height a plan must tile: exactly how renderer.setSize sizes the buffer. */
const backingOf = (input: { cssWidth: number; cssHeight: number; pixelRatio: number }) => ({
  width: Math.floor(input.cssWidth * input.pixelRatio),
  height: Math.floor(input.cssHeight * input.pixelRatio),
});

/** Reusable row-tiling oracle over arbitrary backing rects (used on APPLIED scissors). */
function tileByRows(
  rects: readonly PixelRect[],
  totalWidth: number,
  totalHeight: number,
): { ok: boolean; reason?: string } {
  const bands = [...rects].sort((a, b) => a.y - b.y);
  let cursor = 0;
  for (const r of bands) {
    if (r.x !== 0 || r.width !== totalWidth) {
      return { ok: false, reason: `band not full width: x=${r.x} w=${r.width}` };
    }
    if (r.y !== cursor) return { ok: false, reason: `gap/overlap at y=${cursor}, band starts ${r.y}` };
    cursor += r.height;
  }
  return cursor === totalHeight
    ? { ok: true }
    : { ok: false, reason: `covered ${cursor} of ${totalHeight}` };
}

function runSection(
  results: SectionResult[],
  name: string,
  body: (expect: Expect) => unknown,
): void {
  const failures: string[] = [];
  const expect: Expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  let detail: unknown;
  try {
    detail = body(expect);
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  results.push({ name, pass: failures.length === 0, failures, detail });
}

/** Build a fresh, fully-defined two-camera scenario for the coordinator sections. */
function makeScenario(cssWidth: number, cssHeight: number) {
  const scene = new THREE.Scene();
  scene.name = 'shared-world';
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));

  const p1 = new THREE.PerspectiveCamera(75, 3, 0.05, 2000);
  p1.name = 'P1';
  p1.position.set(-3, 1.6, 4);
  p1.lookAt(0, 1, 0);
  p1.updateProjectionMatrix();

  const p2 = new THREE.PerspectiveCamera(60, 5, 0.1, 1000);
  p2.name = 'P2';
  p2.position.set(3, 1.6, -4);
  p2.lookAt(0, 1, 0);
  p2.updateProjectionMatrix();

  const fake = new FakeRenderer(cssWidth, cssHeight);
  return { scene, cameras: [p1, p2] as const, fake };
}

const ALLOWED_OPS = new Set([
  'setScissorTest:true',
  'setScissorTest:false',
  'setViewport',
  'setScissor',
  'setClearColor',
  'clear',
  'render',
]);

export function buildReport(): EvidenceReport {
  const sections: SectionResult[] = [];

  // ── 1. single-player full screen ────────────────────────────────────────
  runSection(sections, 'singlePlayerFullscreen', (expect) => {
    const cases: CoopViewportInput[] = [
      { cssWidth: 1920, cssHeight: 1080, pixelRatio: 2, players: 1 },
      { cssWidth: 801, cssHeight: 601, pixelRatio: 1, players: 1 },
      { cssWidth: 1280, cssHeight: 720, pixelRatio: 1.5, players: 1 },
      { cssWidth: 375, cssHeight: 812, pixelRatio: 3, players: 1 },
    ];
    const detail = cases.map((input) => {
      const plan = planCoopViewports(input);
      const b = backingOf(input);
      expect(plan.renderable, `1P ${input.cssWidth}x${input.cssHeight}@${input.pixelRatio} refused`);
      if (!plan.renderable) return { input, refused: plan.reason };
      expect(plan.slots.length === 1, '1P must have exactly one slot');
      const slot = plan.slots[0];
      expect(slot.role === 'full', 'sole slot role must be full');
      expect(arraysEqual(rectArray(slot.backing), [0, 0, b.width, b.height]), 'slot must fill backing');
      expect(Math.abs(slot.aspect - b.width / b.height) <= EPS, 'aspect must be backing w/h');
      expect(checkExactTiling(plan).exact, 'full-screen plan must tile exactly');
      return { input, backing: b, slot: rectArray(slot.backing), aspect: slot.aspect };
    });
    return detail;
  });

  // ── 2. horizontal split exact tiling ────────────────────────────────────
  runSection(sections, 'horizontalSplitTiling', (expect) => {
    const cases: Array<{ cssWidth: number; cssHeight: number; pixelRatio: number }> = [
      { cssWidth: 1920, cssHeight: 1080, pixelRatio: 2 },
      { cssWidth: 1280, cssHeight: 720, pixelRatio: 1 },
      { cssWidth: 801, cssHeight: 601, pixelRatio: 1 },
      { cssWidth: 1024, cssHeight: 769, pixelRatio: 1 },
      { cssWidth: 640, cssHeight: 361, pixelRatio: 1 },
      { cssWidth: 333, cssHeight: 667, pixelRatio: 2 },
      { cssWidth: 1080, cssHeight: 2337, pixelRatio: 1 },
      { cssWidth: 1366, cssHeight: 768, pixelRatio: 1.25 },
    ];
    const detail = cases.map((size) => {
      const plan = planCoopViewports({ ...size, players: 2 });
      expect(plan.renderable, `2P ${size.cssWidth}x${size.cssHeight}@${size.pixelRatio} refused`);
      if (!plan.renderable) return { size, refused: plan.reason };
      const b = backingOf(size);
      const [top, bottom] = plan.slots;
      const half = Math.floor(b.height / 2);
      expect(top.role === 'top' && bottom.role === 'bottom', 'slot roles must be [top, bottom]');
      // Default policy: the top slot receives the extra row on odd heights.
      expect(bottom.backing.height === half, `bottom height ${bottom.backing.height} != floor(bh/2) ${half}`);
      expect(top.backing.height === b.height - half, 'top height != ceil(bh/2)');
      // Exact adjacency and full coverage (the seam has no gap and no overlap).
      expect(bottom.backing.y === 0, 'bottom must sit at y=0');
      expect(top.backing.y === bottom.backing.y + bottom.backing.height, 'top must start where bottom ends');
      expect(top.backing.y + top.backing.height === b.height, 'top must reach the buffer top edge');
      expect(top.backing.x === 0 && bottom.backing.x === 0, 'both bands start at x=0');
      expect(top.backing.width === b.width && bottom.backing.width === b.width, 'both bands span full width');
      expect(Math.abs(top.aspect - b.width / top.backing.height) <= EPS, 'top aspect = w / topHeight');
      expect(Math.abs(bottom.aspect - b.width / bottom.backing.height) <= EPS, 'bottom aspect = w / bottomHeight');
      const tiling = checkExactTiling(plan);
      expect(tiling.exact, `tiling not exact: ${tiling.reason ?? ''}`);
      // Round-trip: THREE re-applies round(css*pr); it must reproduce the integers.
      for (const slot of plan.slots) {
        expect(Math.round(slot.css.y * size.pixelRatio) === slot.backing.y, 'y round-trip drifted');
        expect(Math.round(slot.css.height * size.pixelRatio) === slot.backing.height, 'height round-trip drifted');
      }
      return {
        size,
        backing: b,
        top: rectArray(top.backing),
        bottom: rectArray(bottom.backing),
        oddHeight: b.height % 2 === 1,
      };
    });

    // oddRowSlot = 'bottom' flips which band gets the extra row, still exact.
    const flipped = planCoopViewports({ cssWidth: 801, cssHeight: 601, pixelRatio: 1, players: 2, oddRowSlot: 'bottom' });
    expect(flipped.renderable, 'flipped odd-row plan refused');
    if (flipped.renderable) {
      const [top, bottom] = flipped.slots;
      expect(bottom.backing.height === 301 && top.backing.height === 300, 'oddRowSlot=bottom must give bottom the extra row');
      expect(checkExactTiling(flipped).exact, 'flipped plan must still tile exactly');
    }
    return detail;
  });

  // ── 3. seam gap/overlap negative control ────────────────────────────────
  runSection(sections, 'seamNegativeControl', (expect) => {
    // Positive control: a correct odd-height plan is exact.
    const good = planCoopViewports({ cssWidth: 801, cssHeight: 601, pixelRatio: 1, players: 2 });
    expect(good.renderable && checkExactTiling(good).exact, 'correct odd plan should be exact');

    const makeSlot = (index: number, role: 'top' | 'bottom', backing: PixelRect, pr: number): CoopSlot => ({
      index,
      role,
      backing,
      css: { x: backing.x / pr, y: backing.y / pr, width: backing.width / pr, height: backing.height / pr },
      aspect: backing.width / backing.height,
    });
    const base = (slots: CoopSlot[]): RenderableCoopPlan => ({
      renderable: true,
      players: 2,
      pixelRatio: 1,
      backing: { width: 801, height: 601 },
      css: { width: 801, height: 601 },
      slots,
    });

    // Gap: two 300-row bands over a 601-row buffer leave row 600 unpainted.
    const gap = base([
      makeSlot(0, 'top', { x: 0, y: 300, width: 801, height: 300 }, 1),
      makeSlot(1, 'bottom', { x: 0, y: 0, width: 801, height: 300 }, 1),
    ]);
    const gapReport = checkExactTiling(gap);
    expect(!gapReport.exact, 'gap plan must be rejected');

    // Overlap: two 301-row bands over a 601-row buffer share row 300.
    const overlap = base([
      makeSlot(0, 'top', { x: 0, y: 300, width: 801, height: 301 }, 1),
      makeSlot(1, 'bottom', { x: 0, y: 0, width: 801, height: 301 }, 1),
    ]);
    const overlapReport = checkExactTiling(overlap);
    expect(!overlapReport.exact, 'overlap plan must be rejected');

    // The bug an implementer actually writes: split in CSS by rounding each half,
    // which double-counts the middle row on an odd buffer.
    const cssHalf = Math.round(601 / 2); // 301
    const naive = base([
      makeSlot(0, 'top', { x: 0, y: cssHalf, width: 801, height: cssHalf }, 1),
      makeSlot(1, 'bottom', { x: 0, y: 0, width: 801, height: cssHalf }, 1),
    ]);
    const naiveReport = checkExactTiling(naive);
    expect(!naiveReport.exact, 'naive CSS-halving split must be rejected');

    return {
      gap: gapReport.reason,
      overlap: overlapReport.reason,
      naive: naiveReport.reason,
    };
  });

  // ── 4. zero-size / degenerate refusal ───────────────────────────────────
  runSection(sections, 'zeroSizeRefusal', (expect) => {
    const refused: CoopViewportInput[] = [
      { cssWidth: 0, cssHeight: 100, pixelRatio: 1, players: 2 },
      { cssWidth: 100, cssHeight: 0, pixelRatio: 1, players: 2 },
      { cssWidth: -5, cssHeight: 100, pixelRatio: 1, players: 1 },
      { cssWidth: 100, cssHeight: 100, pixelRatio: 0, players: 2 },
      { cssWidth: 100, cssHeight: 100, pixelRatio: -1, players: 1 },
      { cssWidth: Number.NaN, cssHeight: 100, pixelRatio: 1, players: 2 },
      { cssWidth: 100, cssHeight: Number.POSITIVE_INFINITY, pixelRatio: 1, players: 2 },
      { cssWidth: 100, cssHeight: 100, pixelRatio: Number.NaN, players: 1 },
      { cssWidth: 0.4, cssHeight: 0.4, pixelRatio: 1, players: 1 },
      { cssWidth: 2, cssHeight: 1, pixelRatio: 1, players: 2 },
      { cssWidth: 1, cssHeight: 1.9, pixelRatio: 1, players: 2 },
    ];
    for (const input of refused) {
      const plan = planCoopViewports(input);
      expect(!plan.renderable, `should refuse ${JSON.stringify(input)}`);
      if (!plan.renderable) expect(plan.reason.length > 0, 'refusal must carry a reason');
    }
    const accepted: CoopViewportInput[] = [
      { cssWidth: 2, cssHeight: 2, pixelRatio: 1, players: 2 },
      { cssWidth: 1, cssHeight: 1, pixelRatio: 1, players: 1 },
    ];
    for (const input of accepted) {
      const plan = planCoopViewports(input);
      expect(plan.renderable, `should accept ${JSON.stringify(input)}`);
      if (plan.renderable) expect(checkExactTiling(plan).exact, 'accepted plan must tile exactly');
    }
    return { refusedCount: refused.length, acceptedCount: accepted.length };
  });

  // ── 5. resize / DPR determinism ─────────────────────────────────────────
  runSection(sections, 'resizeDeterminism', (expect) => {
    const sequence: Array<{ cssWidth: number; cssHeight: number; pixelRatio: number }> = [
      { cssWidth: 1920, cssHeight: 1080, pixelRatio: 2 },
      { cssWidth: 1280, cssHeight: 1024, pixelRatio: 2 },
      { cssWidth: 1281, cssHeight: 1025, pixelRatio: 2 },
      { cssWidth: 800, cssHeight: 600, pixelRatio: 1 },
      { cssWidth: 801, cssHeight: 601, pixelRatio: 1 },
      { cssWidth: 375, cssHeight: 812, pixelRatio: 3 },
      { cssWidth: 1366, cssHeight: 768, pixelRatio: 1.25 },
    ];
    const runOnce = () =>
      sequence.map((size) => {
        const plan = planCoopViewports({ ...size, players: 2 });
        if (!plan.renderable) return { size, refused: plan.reason };
        expect(checkExactTiling(plan).exact, `resize ${JSON.stringify(size)} not exact`);
        return { size, slots: plan.slots.map((s) => rectArray(s.backing)) };
      });
    const first = JSON.stringify(runOnce());
    const second = JSON.stringify(runOnce());
    expect(first === second, 'resize recomputation is not deterministic');
    return { identical: first === second, steps: sequence.length };
  });

  // ── 6. coordinator split: isolation, aspect, clear, restore ─────────────
  runSection(sections, 'coordinatorSplit', (expect) => {
    const cssWidth = 1920;
    const cssHeight = 1080;
    const pixelRatio = 2;
    const { scene, cameras, fake } = makeScenario(cssWidth, cssHeight);
    const [p1, p2] = cameras;
    const p1AspectBefore = p1.aspect;
    const p2AspectBefore = p2.aspect;
    const p1ProjBefore = p1.projectionMatrix.toArray();
    const p2ProjBefore = p2.projectionMatrix.toArray();

    const plan = planCoopViewports({ cssWidth, cssHeight, pixelRatio, players: 2 });
    if (!plan.renderable) {
      expect(false, `plan refused: ${plan.reason}`);
      return {};
    }

    const coord = new CoopRenderCoordinator();
    const result = coord.renderCoop(plan, scene, cameras, fake, {
      slotClearColors: [new THREE.Color('red'), new THREE.Color('blue')],
    });

    expect(result.rendered, 'coordinator refused a renderable plan');
    expect(result.rendered && result.slots === 2, 'must report two slots rendered');
    expect(fake.renders.length === 2, `expected 2 renders, got ${fake.renders.length}`);
    expect(fake.clears.length === 2, `expected 2 clears, got ${fake.clears.length}`);

    // One shared scene, one camera per slot, in player order.
    expect(fake.renders.every((r) => r.scene === scene), 'a draw used a different scene reference');
    expect(fake.renders[0].camera === p1 && fake.renders[1].camera === p2, 'cameras out of player order');

    // Each draw ran under the scissor test, autoClear disabled, at its slot rect.
    plan.slots.forEach((slot, i) => {
      const r = fake.renders[i];
      expect(r.scissorTest, `draw ${i} not under scissor test`);
      expect(!r.autoClear, `draw ${i} had autoClear on`);
      expect(arraysEqual(r.scissor, rectArray(slot.css)), `draw ${i} scissor != slot css`);
      expect(arraysEqual(r.viewport, rectArray(slot.css)), `draw ${i} viewport != slot css`);
      expect(Math.abs(r.cameraAspect - slot.aspect) <= EPS, `draw ${i} camera aspect != slot aspect`);
      const c = fake.clears[i];
      expect(c.scissorTest && arraysEqual(c.scissor, rectArray(slot.css)), `clear ${i} not scissored to slot`);
      expect(c.color === true, `clear ${i} did not clear colour`);
    });
    expect(fake.clears[0].clearColor === 'ff0000', 'top slot not cleared red');
    expect(fake.clears[1].clearColor === '0000ff', 'bottom slot not cleared blue');

    // End-to-end isolation: the APPLIED scissors tile the buffer exactly.
    const appliedBacking: PixelRect[] = fake.renders.map((r) => ({
      x: Math.round(r.scissor[0] * pixelRatio),
      y: Math.round(r.scissor[1] * pixelRatio),
      width: Math.round(r.scissor[2] * pixelRatio),
      height: Math.round(r.scissor[3] * pixelRatio),
    }));
    const applied = tileByRows(appliedBacking, plan.backing.width, plan.backing.height);
    expect(applied.ok, `applied scissors do not isolate/tile: ${applied.reason ?? ''}`);

    // No duplicated simulation: only the presentation op vocabulary was used.
    const strayOps = fake.ops.filter((op) => !ALLOWED_OPS.has(op));
    expect(strayOps.length === 0, `unexpected ops: ${strayOps.join(', ')}`);
    expect(fake.ops.filter((op) => op === 'render').length === 2, 'render count != slot count');

    // State restored to exactly what it was before the call.
    const vp = fake.getViewport(new THREE.Vector4());
    const sc = fake.getScissor(new THREE.Vector4());
    expect(arraysEqual([vp.x, vp.y, vp.z, vp.w], [0, 0, cssWidth, cssHeight]), 'viewport not restored');
    expect(arraysEqual([sc.x, sc.y, sc.z, sc.w], [0, 0, cssWidth, cssHeight]), 'scissor not restored');
    expect(fake.getScissorTest() === false, 'scissor test not restored');
    expect(fake.autoClear === true, 'autoClear not restored');
    expect(fake.getClearColor(new THREE.Color()).getHexString() === '000000', 'clear colour not restored');
    expect(fake.getClearAlpha() === 1, 'clear alpha not restored');

    // Cameras restored: aspect AND projection matrix.
    expect(p1.aspect === p1AspectBefore && p2.aspect === p2AspectBefore, 'camera aspect not restored');
    expect(arraysEqual(p1.projectionMatrix.toArray(), p1ProjBefore), 'P1 projection not restored');
    expect(arraysEqual(p2.projectionMatrix.toArray(), p2ProjBefore), 'P2 projection not restored');

    return {
      slots: plan.slots.map((s) => rectArray(s.css)),
      applied: appliedBacking.map(rectArray),
      ops: fake.ops,
    };
  });

  // ── 7. restoration survives a throwing draw ─────────────────────────────
  runSection(sections, 'coordinatorRestoresOnThrow', (expect) => {
    const cssWidth = 1281; // odd backing to combine both hazards
    const cssHeight = 721;
    const pixelRatio = 1;
    const { scene, cameras, fake } = makeScenario(cssWidth, cssHeight);
    const [p1, p2] = cameras;
    const p1AspectBefore = p1.aspect;
    const p2AspectBefore = p2.aspect;
    const p1ProjBefore = p1.projectionMatrix.toArray();
    const p2ProjBefore = p2.projectionMatrix.toArray();
    fake.throwOnRender = 1;

    const plan = planCoopViewports({ cssWidth, cssHeight, pixelRatio, players: 2 });
    let threw = false;
    let message = '';
    try {
      const coord = new CoopRenderCoordinator();
      coord.renderCoop(plan, scene, cameras, fake);
    } catch (error) {
      threw = true;
      message = error instanceof Error ? error.message : String(error);
    }

    expect(threw, 'forced draw failure did not propagate');
    expect(message.includes('forced failure'), 'unexpected error surfaced');
    // Despite the throw, every value is restored by the finally.
    const vp = fake.getViewport(new THREE.Vector4());
    expect(arraysEqual([vp.x, vp.y, vp.z, vp.w], [0, 0, cssWidth, cssHeight]), 'viewport leaked after throw');
    expect(fake.getScissorTest() === false, 'scissor test leaked after throw');
    expect(fake.autoClear === true, 'autoClear leaked after throw');
    expect(fake.getClearColor(new THREE.Color()).getHexString() === '000000', 'clear colour leaked after throw');
    expect(p1.aspect === p1AspectBefore && p2.aspect === p2AspectBefore, 'camera aspect leaked after throw');
    expect(arraysEqual(p1.projectionMatrix.toArray(), p1ProjBefore), 'P1 projection leaked after throw');
    expect(arraysEqual(p2.projectionMatrix.toArray(), p2ProjBefore), 'P2 projection leaked after throw');
    return { threw, message };
  });

  // ── 8. the isolation oracle can fail ────────────────────────────────────
  runSection(sections, 'isolationOracleControl', (expect) => {
    const backing = { width: 800, height: 600 };
    const good: PixelRect[] = [
      { x: 0, y: 300, width: 800, height: 300 },
      { x: 0, y: 0, width: 800, height: 300 },
    ];
    expect(tileByRows(good, backing.width, backing.height).ok, 'clean tiling should pass');
    // Corrupt slot 0 to overlap slot 1 (the exact leak section 6 must forbid).
    const leaked: PixelRect[] = [
      { x: 0, y: 0, width: 800, height: 300 },
      { x: 0, y: 0, width: 800, height: 300 },
    ];
    const report = tileByRows(leaked, backing.width, backing.height);
    expect(!report.ok, 'overlapping scissors must be rejected');
    return { leakReason: report.reason };
  });

  // ── 9. single-player coordinator path ───────────────────────────────────
  runSection(sections, 'singlePlayerCoordinator', (expect) => {
    const cssWidth = 1600;
    const cssHeight = 900;
    const pixelRatio = 2;
    const { scene, cameras, fake } = makeScenario(cssWidth, cssHeight);
    const [p1] = cameras;
    const aspectBefore = p1.aspect;
    const plan = planCoopViewports({ cssWidth, cssHeight, pixelRatio, players: 1 });
    const coord = new CoopRenderCoordinator();
    const result = coord.renderCoop(plan, scene, [p1], fake);

    expect(result.rendered && result.slots === 1, 'single-player must render one slot');
    expect(fake.renders.length === 1, 'single-player must draw exactly once');
    expect(arraysEqual(fake.renders[0].scissor, [0, 0, cssWidth, cssHeight]), 'sole slot not full screen');
    expect(arraysEqual(fake.renders[0].viewport, [0, 0, cssWidth, cssHeight]), 'sole viewport not full screen');
    if (plan.renderable) {
      expect(Math.abs(fake.renders[0].cameraAspect - plan.slots[0].aspect) <= EPS, 'aspect != full-screen aspect');
    }
    expect(p1.aspect === aspectBefore, 'camera aspect not restored (1P)');
    expect(fake.getScissorTest() === false, 'scissor test leaked (1P)');
    return { slot: fake.renders[0].scissor };
  });

  // ── 10. coordinator determinism ─────────────────────────────────────────
  runSection(sections, 'coordinatorDeterminism', (expect) => {
    const run = () => {
      const { scene, cameras, fake } = makeScenario(1440, 900);
      const plan = planCoopViewports({ cssWidth: 1440, cssHeight: 900, pixelRatio: 2, players: 2 });
      new CoopRenderCoordinator().renderCoop(plan, scene, cameras, fake, {
        slotClearColors: [new THREE.Color('red'), new THREE.Color('blue')],
      });
      return {
        ops: fake.ops,
        renders: fake.renders.map((r) => ({
          cameraName: r.cameraName,
          aspect: r.cameraAspect,
          viewport: r.viewport,
          scissor: r.scissor,
          scissorTest: r.scissorTest,
          autoClear: r.autoClear,
          clearColor: r.clearColor,
        })),
        clears: fake.clears.map((c) => ({ scissor: c.scissor, clearColor: c.clearColor })),
      };
    };
    const a = JSON.stringify(run());
    const b = JSON.stringify(run());
    expect(a === b, 'two identical coordinator runs recorded differently');
    return { identical: a === b };
  });

  // ── 11. a refusal / mismatch touches no state ───────────────────────────
  runSection(sections, 'refusalIsInert', (expect) => {
    // Zero-size refusal: coordinator must not touch the renderer.
    const zero = makeScenario(1280, 720);
    const refusedPlan: CoopViewportPlan = planCoopViewports({ cssWidth: 0, cssHeight: 720, pixelRatio: 2, players: 2 });
    const coordA = new CoopRenderCoordinator();
    const r1 = coordA.renderCoop(refusedPlan, zero.scene, zero.cameras, zero.fake);
    expect(!r1.rendered, 'refused plan should not render');
    expect(zero.fake.ops.length === 0, 'refused plan mutated renderer state');
    expect(zero.fake.getScissorTest() === false, 'refused plan enabled scissor test');

    // Camera-count mismatch: valid plan, wrong number of cameras → inert refusal.
    const mismatch = makeScenario(1280, 720);
    const validPlan = planCoopViewports({ cssWidth: 1280, cssHeight: 720, pixelRatio: 2, players: 2 });
    const r2 = new CoopRenderCoordinator().renderCoop(validPlan, mismatch.scene, [mismatch.cameras[0]], mismatch.fake);
    expect(!r2.rendered, 'camera-count mismatch should refuse');
    expect(!r2.rendered && r2.reason.includes('camera'), 'mismatch reason should mention cameras');
    expect(mismatch.fake.ops.length === 0, 'mismatch mutated renderer state');
    return { zeroReason: !r1.rendered ? r1.reason : null, mismatchReason: !r2.rendered ? r2.reason : null };
  });

  const passed = sections.filter((s) => s.pass).length;
  const failures = sections.flatMap((s) => s.failures.map((f) => `${s.name}: ${f}`));
  return {
    library: 'coop/render',
    threeRevision: THREE.REVISION,
    ok: failures.length === 0,
    passed,
    total: sections.length,
    failures,
    sections,
  };
}
