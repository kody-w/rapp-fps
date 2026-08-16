#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(raw);
  if (!match) {
    console.error(`REFUSING: unparseable argument "${raw}". Expected --key=value.`);
    process.exit(9);
  }
  args.set(match[1], match[2]);
}
const TARGET = args.get('url');
if (!TARGET) {
  console.error('REFUSING: --url is required; co-op trials never guess a branch or port.');
  process.exit(9);
}
const OUT = args.get('out') ?? 'shots/coop-trials';
const BUDGET_MS = Number(args.get('budget') ?? 16.7);
if (!Number.isFinite(BUDGET_MS) || BUDGET_MS <= 0) process.exit(9);

const MISSIONS = ['cargo-breach', 'relay-blackout', 'foundry-last-light'];

function targetUrl(missionId) {
  const url = new URL(TARGET);
  url.searchParams.set('mission', missionId);
  url.searchParams.set('campaignFixture', '1');
  url.searchParams.set('coopFixture', '1');
  return url.href;
}

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, 'coop-trials.json'), { force: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const reports = [];

for (let trial = 1; trial <= 3; trial++) {
  const missionId = MISSIONS[trial - 1];
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(targetUrl(missionId), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => (
    window.__FRAME_READY__ === true
    && window.__COOP__?.state?.playerCount === 2
  ), null, { timeout: 45_000 });

  const gpu = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      supported: window.engine.profiler.gpuSupported,
      renderer: String(
        gl && debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : 'unknown',
      ),
    };
  });
  assert(gpu.supported, 'GPU timer unavailable');
  assert(!/swiftshader|llvmpipe|software/i.test(gpu.renderer), gpu.renderer);

  await page.mouse.click(480, 270);
  await page.evaluate(() => {
    window.__COOP_TEST__.setAxes([0.65, -0.8, 0.42, -0.18]);
    window.__COOP_TEST__.setButton('fire', true);
    window.engine.profiler.reset();
  });
  await page.keyboard.down('KeyW');
  await page.mouse.down();
  const motion = (async () => {
    for (let frame = 0; frame < 100; frame++) {
      await page.mouse.move(
        480 + Math.sin(frame / 7) * 240,
        270 + Math.cos(frame / 11) * 70,
      );
      await page.waitForTimeout(16);
    }
  })();
  await page.waitForFunction(
    () => window.engine.profiler.snapshot().budgetFrameMs.samples >= 120,
    null,
    { timeout: 60_000 },
  );
  await motion;
  await page.keyboard.up('KeyW');
  await page.mouse.up();
  await page.evaluate(() => window.__COOP_TEST__.neutral());
  await page.waitForTimeout(100);

  const measured = await page.evaluate(() => ({
    profiler: window.engine.profiler.snapshot(),
    coop: window.__COOP__.state,
    stats: window.__SCENE_STATS__,
  }));
  const p95 = measured.profiler.budgetFrameMs.p95;
  const passed = (
    Number.isFinite(p95)
    && p95 <= BUDGET_MS
    && measured.coop.playerCount === 2
    && measured.coop.simulation.worlds === 1
    && errors.length === 0
    && measured.profiler.gpuDisjointCount === 0
  );
  await page.screenshot({ path: join(OUT, `trial-${trial}.png`) });
  reports.push({
    trial,
    missionId,
    passed,
    p95,
    gpuP95: measured.profiler.gpuFrameMs.p95,
    cpuP95: measured.profiler.cpuFrameMs.p95,
    samples: measured.profiler.budgetFrameMs.samples,
    renderer: gpu.renderer,
    playerCount: measured.coop.playerCount,
    simulation: measured.coop.simulation,
    sceneStats: measured.stats,
    errors,
  });
  console.log(
    `${passed ? 'PASS' : 'FAIL'} ${missionId} co-op trial: `
      + `p95=${p95.toFixed(3)}ms, draws=${measured.stats?.drawCallsPerFrame ?? 'n/a'}`,
  );
  await page.close();
}

const verdict = reports.every((report) => report.passed)
  ? 'CO-OP TRIALS VERIFIED'
  : 'FAILED';
const output = {
  verdict,
  target: TARGET,
  budgetMs: BUDGET_MS,
  worstP95: Math.max(...reports.map((report) => report.p95)),
  reports,
};
writeFileSync(
  join(OUT, 'coop-trials.json'),
  JSON.stringify(output, null, 2),
);
await browser.close();

if (verdict !== 'CO-OP TRIALS VERIFIED') process.exit(1);
console.log(`${verdict} — 3/3 simultaneous two-player loads passed.`);
