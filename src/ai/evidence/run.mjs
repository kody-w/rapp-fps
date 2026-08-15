import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { assertWithinFrameBudget } from './budget-verdict.mjs';

const BASE_URL = process.env.AI_URL ?? 'http://127.0.0.1:5341';
const OUTPUT = dirname(fileURLToPath(import.meta.url));
const MACHINE_REPORT = join(OUTPUT, 'report.json');
const VISUAL_REPORT = join(OUTPUT, 'visual-report.json');
const BUDGET_FIXTURE = join(OUTPUT, 'budget-fixture.mjs');
const SHOTS = ['patrol', 'investigate', 'engage', 'search', 'cover'];
const FRAME_BUDGET_MS = 16.7;
const EVIDENCE_PATH = 'src/ai/evidence';

mkdirSync(OUTPUT, { recursive: true });
for (const name of SHOTS) rmSync(join(OUTPUT, `${name}.png`), { force: true });
rmSync(MACHINE_REPORT, { force: true });
rmSync(VISUAL_REPORT, { force: true });

const budgetFixture = spawnSync(
  process.execPath,
  [BUDGET_FIXTURE, String(FRAME_BUDGET_MS + 1), String(FRAME_BUDGET_MS)],
  { encoding: 'utf8' },
);
assert.notEqual(
  budgetFixture.status,
  0,
  'over-budget fixture unexpectedly exited successfully',
);
const budgetFixtureSummary = budgetFixture.stderr
  .trim()
  .split('\n')
  .find((line) => line.includes('exceeds'))
  ?? `fixture exited ${String(budgetFixture.status)}`;

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
  ],
});
const consoleErrors = [];

function watch(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
}

try {
  const evidencePage = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  watch(evidencePage);
  await evidencePage.goto(`${BASE_URL}/evidence.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await evidencePage.waitForFunction(
    () => window.__AI_EVIDENCE_READY__ === true,
    null,
    { timeout: 60_000 },
  );
  const machine = await evidencePage.evaluate(() => window.__AI_EVIDENCE__);
  assert.equal(machine.passed, true, 'deterministic AI evidence suite failed');
  writeFileSync(
    MACHINE_REPORT,
    `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      vitePort: 5341,
      ...machine,
      consoleErrors: [...consoleErrors],
    }, null, 2)}\n`,
  );
  await evidencePage.close();

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  watch(page);
  await page.goto(`${BASE_URL}/harness.html?shot=patrol`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });

  const initial = await page.evaluate(() => window.__AI_HARNESS__.report());
  assert.equal(initial.gpu.webgl2, true, 'hardware evidence requires WebGL2');
  assert.doesNotMatch(
    initial.gpu.renderer,
    /swiftshader|llvmpipe|software/i,
    `refusing software-rendered AI evidence: ${initial.gpu.renderer}`,
  );
  assert.equal(initial.profiler.gpuSupported, true, 'GPU timer queries are unavailable');

  await page.evaluate(() => window.__AI_HARNESS__.setShot('cover'));
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__AI_HARNESS__.resetProfiler());
  await page.waitForFunction(
    () => window.__AI_HARNESS__.profiler.snapshot().budgetFrameMs.samples >= 120,
    null,
    { timeout: 60_000 },
  );
  const measured = await page.evaluate(() => window.__AI_HARNESS__.report());
  const profiler = measured.profiler;
  assert.equal(profiler.gpuDisjointCount, 0, 'GPU timing became disjoint');
  assert.ok(profiler.gpuFrameMs.p95 !== null, 'GPU p95 is missing');
  assert.ok(profiler.cpuFrameMs.p95 !== null, 'CPU p95 is missing');
  assert.ok(profiler.rafIntervalMs.p95 !== null, 'rAF p95 is missing');
  assert.ok(profiler.budgetFrameMs.p95 !== null, 'paired budget p95 is missing');
  assert.equal(
    profiler.budgetFrameMsP95,
    profiler.budgetFrameMs.p95,
    'budgetFrameMsP95 alias does not match the paired distribution',
  );

  const pairedP95 = profiler.budgetFrameMs.p95;
  const budgetResult = assertWithinFrameBudget(pairedP95, FRAME_BUDGET_MS);
  const overBudget = budgetResult.overBudget;
  const expectedStates = {
    patrol: 'patrol',
    investigate: 'investigate',
    engage: 'engage',
    search: 'search',
    cover: 'reposition',
  };
  const shots = [];
  for (const name of SHOTS) {
    const state = await page.evaluate(
      (shot) => window.__AI_HARNESS__.setShot(shot),
      name,
    );
    assert.equal(state.state, expectedStates[name], `${name} shot reached ${state.state}`);
    if (name === 'engage') assert.equal(state.targetVisible, true, 'engage shot lacks LOS');
    if (name === 'investigate' || name === 'search' || name === 'cover') {
      assert.ok(state.pathCount > 0, `${name} shot lacks a debug path`);
    }
    if (name === 'cover') {
      assert.ok(state.coverCount > 0, 'cover shot lacks scored candidates');
      assert.ok(state.selectedCoverIndex >= 0, 'cover shot lacks a selected candidate');
    }
    await page.waitForTimeout(120);
    const path = join(OUTPUT, `${name}.png`);
    await page.screenshot({ path, type: 'png' });
    shots.push({
      name,
      state,
      path: `${EVIDENCE_PATH}/${name}.png`,
    });
  }

  assert.deepEqual(consoleErrors, [], `browser console errors:\n${consoleErrors.join('\n')}`);
  const visual = {
    capturedAt: new Date().toISOString(),
    url: `${BASE_URL}/harness.html`,
    vitePort: 5341,
    viewport: '1920x1080',
    hardware: measured.gpu,
    profiler,
    performance: {
      frameBudgetMs: FRAME_BUDGET_MS,
      gpuFrameMs: profiler.gpuFrameMs,
      cpuFrameMs: profiler.cpuFrameMs,
      rafIntervalMs: profiler.rafIntervalMs,
      budgetFrameMs: profiler.budgetFrameMs,
      budgetFrameMsMedian: profiler.budgetFrameMsMedian,
      budgetFrameMsP95: profiler.budgetFrameMsP95,
      pairedP95Ms: pairedP95,
      overBudget,
      verdict: budgetResult.verdict,
      note: 'budgetFrameMs is max(CPU, GPU) paired by the frame that issued the true EXT_disjoint_timer_query_webgl2 query.',
    },
    drawCalls: measured.drawCalls,
    triangles: measured.triangles,
    shots,
    budgetNegativeControl: {
      fixture: `${EVIDENCE_PATH}/budget-fixture.mjs`,
      pairedP95Ms: FRAME_BUDGET_MS + 1,
      budgetMs: FRAME_BUDGET_MS,
      exitCode: budgetFixture.status,
      expectedNonzeroExitObserved: budgetFixture.status !== 0,
      failureSummary: budgetFixtureSummary,
    },
    consoleErrors,
    caveats: measured.caveats,
  };
  writeFileSync(VISUAL_REPORT, `${JSON.stringify(visual, null, 2)}\n`);
  console.log(JSON.stringify({
    machinePassed: machine.passed,
    renderer: measured.gpu.renderer,
    pairedP95Ms: pairedP95,
    budgetVerdict: visual.performance.verdict,
    shots: shots.map((shot) => shot.path),
    consoleErrors,
  }, null, 2));
} finally {
  await browser.close();
}
