/**
 * The shot tool. Renders the game headlessly and writes real frames to disk.
 *
 * Every quality claim in this project has to point at one of these files. A
 * critic that reviews a description instead of a frame is reviewing my
 * opinion, which is worth nothing.
 *
 * Two things it refuses to do, both learned the hard way elsewhere:
 *
 *  - It will not capture before the scene has actually presented frames. A
 *    screenshot taken on `load` is a black rectangle, and a black rectangle
 *    reviewed by a critic produces confident nonsense.
 *  - It will not silently accept a software rasteriser. If the GPU is not
 *    driving, the image is not the image players would see, and the whole
 *    exercise is measuring the wrong thing. It says so and exits non-zero.
 *
 * Usage:  node tools/shoot.mjs [--out shots/2026-08-07] [--shots a,b,c]
 */

import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SUPPORTED_ARGS = new Set([
  'url', 'out', 'width', 'height', 'cpuThrottle', 'rafDelay',
  'forceNoGpuTimer', 'budgetMs', 'shots',
]);

function parseArgs(argv) {
  const values = {};
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      errors.push(`unexpected positional argument "${token}"`);
      continue;
    }
    const equals = /^--([^=]+)=(.*)$/.exec(token);
    const key = equals ? equals[1] : token.slice(2);
    let value = equals?.[2];
    if (!SUPPORTED_ARGS.has(key)) {
      errors.push(`unknown option "--${key}"`);
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`option "--${key}" requires a value`);
        continue;
      }
      value = next;
      i++;
    }
    values[key] = value;
  }
  return { values, errors };
}

const parsed = parseArgs(process.argv.slice(2));
const args = parsed.values;

const URL_BASE = args.url ?? 'http://127.0.0.1:5273/';
const OUT = args.out ?? 'shots/latest';
const WIDTH = Number(args.width ?? 1920);
const HEIGHT = Number(args.height ?? 1080);
const CPU_THROTTLE = Number(args.cpuThrottle ?? 1);
const RAF_DELAY = Number(args.rafDelay ?? 0);
const FORCE_NO_GPU_TIMER = args.forceNoGpuTimer === '1';
const FRAME_BUDGET_MS = Number(args.budgetMs ?? 16.7);

mkdirSync(OUT, { recursive: true });
const REPORT_PATH = join(OUT, 'report.json');
// Refusal must not leave yesterday's green report behind in a reused output
// directory. Remove it before any capability check can exit.
rmSync(REPORT_PATH, { force: true });
if (parsed.errors.length > 0) {
  console.error(`REFUSING: invalid arguments:\n- ${parsed.errors.join('\n- ')}`);
  process.exit(9);
}
if (!Number.isFinite(FRAME_BUDGET_MS) || FRAME_BUDGET_MS <= 0) {
  console.error(`REFUSING: invalid frame budget "${args.budgetMs ?? ''}". `
    + 'Expected a finite positive number of milliseconds.');
  process.exit(8);
}
const controlErrors = [];
if (!Number.isInteger(WIDTH) || WIDTH <= 0 || WIDTH > 16384) {
  controlErrors.push(`width must be an integer in 1..16384, got "${args.width ?? WIDTH}"`);
}
if (!Number.isInteger(HEIGHT) || HEIGHT <= 0 || HEIGHT > 16384) {
  controlErrors.push(`height must be an integer in 1..16384, got "${args.height ?? HEIGHT}"`);
}
if (!Number.isFinite(CPU_THROTTLE) || CPU_THROTTLE < 1 || CPU_THROTTLE > 100) {
  controlErrors.push(`cpuThrottle must be finite in 1..100, got "${args.cpuThrottle ?? CPU_THROTTLE}"`);
}
if (!Number.isFinite(RAF_DELAY) || RAF_DELAY < 0 || RAF_DELAY > 60_000) {
  controlErrors.push(`rafDelay must be finite in 0..60000, got "${args.rafDelay ?? RAF_DELAY}"`);
}
if (
  args.forceNoGpuTimer !== undefined
  && args.forceNoGpuTimer !== '0'
  && args.forceNoGpuTimer !== '1'
) {
  controlErrors.push(
    `forceNoGpuTimer must be exactly 0 or 1, got "${args.forceNoGpuTimer}"`,
  );
}
try {
  const parsedUrl = new URL(URL_BASE);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    controlErrors.push(`url protocol must be http or https, got "${parsedUrl.protocol}"`);
  }
} catch {
  controlErrors.push(`url is not valid, got "${URL_BASE}"`);
}
if (controlErrors.length > 0) {
  console.error(`REFUSING: invalid controls:\n- ${controlErrors.join('\n- ')}`);
  process.exit(10);
}

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
  ],
});

const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});
if (CPU_THROTTLE > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
}
if (RAF_DELAY > 0) {
  // Negative control for the profiler: delay callback delivery without
  // changing the render commands bracketed by the GPU timer query. A correct
  // profiler reports a larger rAF interval while GPU cost stays stable.
  await page.addInitScript((delay) => {
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => nativeRaf(() => {
      setTimeout(() => callback(performance.now()), delay);
    });
  }, RAF_DELAY);
}

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Refuse a software rasteriser rather than quietly measuring the wrong thing.
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { ok: false, renderer: 'no webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  return { ok: true, renderer: String(renderer) };
});
if (!gpu.ok || /swiftshader|llvmpipe|software/i.test(gpu.renderer)) {
  console.error(`REFUSING: not a hardware renderer — "${gpu.renderer}". `
    + `Frames captured here would not be the frames a player sees.`);
  await browser.close();
  process.exit(2);
}

// Wait for real presented frames, not for `load`.
try {
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, { timeout: 45_000 });
} catch {
  console.error('REFUSING: the scene never reported a presented frame within 45s.');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

// Let temporal effects (SMAA history, AO denoise) settle so the capture is the
// converged image rather than frame one of an accumulating effect.
await page.waitForTimeout(1200);

const profilerSupport = FORCE_NO_GPU_TIMER
  ? false
  : await page.evaluate(() => window.engine?.profiler?.gpuSupported ?? false);
if (!profilerSupport) {
  console.error('REFUSING: EXT_disjoint_timer_query_webgl2 is unavailable. '
    + 'GPU frame cost is UNVERIFIED; rAF cadence will not be substituted.');
  await browser.close();
  process.exit(4);
}

await page.evaluate(() => window.engine.profiler.reset());
try {
  await page.waitForFunction(
    () => window.engine.profiler.snapshot().budgetFrameMs.samples >= 120,
    null,
    { timeout: 60_000 },
  );
} catch {
  const partial = await page.evaluate(() => window.engine.profiler.snapshot());
  console.error('REFUSING: fewer than 120 completed GPU timer queries in 60s.');
  console.error(JSON.stringify(partial, null, 2));
  await browser.close();
  process.exit(5);
}

const timings = await page.evaluate(() => window.engine.profiler.snapshot());
if (timings.gpuDisjointCount > 0) {
  console.error(`REFUSING: ${timings.gpuDisjointCount} disjoint GPU timing event(s).`);
  await browser.close();
  process.exit(6);
}

const perf = await page.evaluate((measured) => {
  const s = window.__SCENE_STATS__ ?? {};
  return {
    gpuSupported: measured.gpuSupported,
    gpuCounterBits: measured.gpuCounterBits,
    gpuFrameMs: measured.gpuFrameMs,
    cpuFrameMs: measured.cpuFrameMs,
    rafIntervalMs: measured.rafIntervalMs,
    budgetFrameMsMedian: measured.budgetFrameMsMedian,
    budgetFrameMsP95: measured.budgetFrameMsP95,
    budgetFrameMs: measured.budgetFrameMs,
    gpuDisjointCount: measured.gpuDisjointCount,
    note: 'budget uses max(CPU, GPU); rAF interval is scheduler cadence only',
    drawCallsPerFrame: s.drawCallsPerFrame ?? null,
    trianglesPerFrame: s.trianglesPerFrame ?? null,
    programs: s.programs ?? null,
    textures: s.textures ?? null,
    geometries: s.geometries ?? null,
  };
}, timings);

const shots = (args.shots ?? 'default').split(',').filter(Boolean);
const written = [];
for (const name of shots) {
  if (name !== 'default') {
    // A named shot may reposition the camera through a hook the level exposes.
    await page.evaluate((n) => window.__SHOT__?.(n), name);
    await page.waitForTimeout(700);
  }
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  written.push(file);
}

const report = {
  at: new Date().toISOString(),
  renderer: gpu.renderer,
  viewport: `${WIDTH}x${HEIGHT}`,
  cpuThrottleRate: CPU_THROTTLE,
  rafDelayMs: RAF_DELAY,
  frameBudgetMs: FRAME_BUDGET_MS,
  overBudget: perf.budgetFrameMsP95 > FRAME_BUDGET_MS,
  performance: perf,
  shots: written,
  consoleErrors,
};
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
process.exit(consoleErrors.length ? 1 : report.overBudget ? 7 : 0);
