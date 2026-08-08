import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE_URL = process.env.HUD_URL ?? 'http://127.0.0.1:5332/harness.html';
const OUTPUT = dirname(fileURLToPath(import.meta.url));
const REPORT = join(OUTPUT, 'report.json');
const EVIDENCE_PATH = 'src/hud/evidence';
const STATES = [
  'hip',
  'ads',
  'reload',
  'damaged-left',
  'low-health',
  'hit-confirm',
  'objective',
];
const BUDGET_MS = 16.7;

mkdirSync(OUTPUT, { recursive: true });
for (const name of [...STATES, 'debug']) {
  rmSync(join(OUTPUT, `${name}.png`), { force: true });
}
rmSync(REPORT, { force: true });

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
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  await page.goto(`${BASE_URL}?state=objective&hudDebug=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });

  const gpu = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { ok: false, renderer: 'no webgl2' };
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : 'unknown';
    return { ok: true, renderer: String(renderer) };
  });
  assert.equal(gpu.ok, true, `hardware evidence requires WebGL2: ${gpu.renderer}`);
  assert.doesNotMatch(
    gpu.renderer,
    /swiftshader|llvmpipe|software/i,
    `refusing software-rendered evidence: ${gpu.renderer}`,
  );

  const supported = await page.evaluate(() => window.engine.profiler.gpuSupported);
  assert.equal(supported, true, 'GPU timer queries are unavailable');
  await page.evaluate(() => window.engine.profiler.reset());
  await page.waitForFunction(
    () => window.engine.profiler.snapshot().budgetFrameMs.samples >= 120,
    null,
    { timeout: 60_000 },
  );
  const profiler = await page.evaluate(() => window.engine.profiler.snapshot());
  assert.equal(profiler.gpuDisjointCount, 0, 'GPU timing became disjoint');
  assert.ok(profiler.gpuFrameMs.p95 !== null, 'GPU p95 is missing');
  assert.ok(profiler.cpuFrameMs.p95 !== null, 'CPU p95 is missing');
  assert.ok(profiler.budgetFrameMs.p95 !== null, 'paired p95 is missing');

  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUTPUT, 'debug.png'), type: 'png' });

  await page.goto(`${BASE_URL}?state=hip`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });

  const shots = [];
  for (const name of STATES) {
    await page.evaluate(
      (state) => window.__HUD_HARNESS__.setState(state),
      name,
    );
    const path = join(OUTPUT, `${name}.png`);
    await page.screenshot({ path, type: 'png' });
    shots.push(`${EVIDENCE_PATH}/${name}.png`);
  }

  const drawCalls = await page.evaluate(() => window.engine.renderer.info.render.calls);
  const pairedP95 = profiler.budgetFrameMs.p95;
  const report = {
    capturedAt: new Date().toISOString(),
    url: BASE_URL,
    vitePort: 5332,
    renderer: gpu.renderer,
    viewport: '1920x1080',
    frameBudgetMs: BUDGET_MS,
    performance: {
      gpuFrameMs: profiler.gpuFrameMs,
      cpuFrameMs: profiler.cpuFrameMs,
      pairedFrameMs: profiler.budgetFrameMs,
      pairedP95Ms: pairedP95,
      drawCalls,
      overBudget: pairedP95 > BUDGET_MS,
      note: 'paired frame cost is max(CPU, GPU) for the same issued frame',
    },
    debugOverlay: {
      query: 'hudDebug=1',
      screenshot: `${EVIDENCE_PATH}/debug.png`,
    },
    shots,
    consoleErrors,
  };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(consoleErrors, [], `browser console errors:\n${consoleErrors.join('\n')}`);
} finally {
  await browser.close();
}
