import { chromium } from 'playwright';

const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const url = urlArg?.slice('--url='.length)
  ?? 'http://127.0.0.1:5347/src/weapons/dev/index.html?evidence=1&stress=1';
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

const failures = [];
let assertions = 0;
const assert = (condition, message) => {
  assertions++;
  if (!condition) failures.push(message);
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, { timeout: 45_000 });
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    window.__RESET_WEAPON_PROFILE__();
    window.engine.profiler.reset();
  });
  await page.waitForFunction(
    () => window.engine.profiler.snapshot().budgetFrameMs.samples >= 120,
    null,
    { timeout: 60_000 },
  );
  const measured = await page.evaluate(() => ({
    profiler: window.engine.profiler.snapshot(),
    profile: { ...window.__WEAPON_PROFILE__ },
    endAmmo: window.__WEAPON__.magazineAmmo,
    reloading: window.__WEAPON__.isReloading,
    stressMode: window.__STRESS_MODE__,
    stats: window.__SCENE_STATS__,
  }));

  const ammoSpent = measured.profile.startAmmo - measured.endAmmo;
  assert(measured.stressMode === true, 'stress harness must use unlimited-magazine mode');
  assert(measured.profiler.gpuSupported === true, 'stress profiler must use GPU timer queries');
  assert(measured.profiler.gpuDisjointCount === 0,
    `stress profiler must have zero disjoint events; received ${measured.profiler.gpuDisjointCount}`);
  assert(measured.profiler.budgetFrameMs.samples >= 120,
    `stress profiler must collect at least 120 samples; received ${measured.profiler.budgetFrameMs.samples}`);
  assert(measured.profile.fired >= 15,
    `stress window must contain sustained firing; received ${measured.profile.fired} shots`);
  assert(measured.profile.flashFrames > 0,
    `stress window must contain active muzzle-flash frames; received ${measured.profile.flashFrames}`);
  assert(measured.profile.flashDrawCallsMax > 84,
    `active flash frames must exceed the 84-call idle frame; received ${measured.profile.flashDrawCallsMax}`);
  assert(measured.profile.reloadStarts === 0 && measured.profile.reloadEnds === 0,
    `stress window must contain no reload; received ${measured.profile.reloadStarts}/${measured.profile.reloadEnds}`);
  assert(measured.reloading === false, 'weapon must not be reloading at stress-window end');
  assert(measured.profile.shakes === 0,
    `stress window must emit zero destructive Shake events; received ${measured.profile.shakes}`);
  assert(ammoSpent === measured.profile.fired,
    `ammo spent must equal fired events; spent ${ammoSpent}, fired ${measured.profile.fired}`);
  assert(measured.profiler.budgetFrameMs.p95 <= 16.7,
    `stress p95 must fit 16.7ms; received ${measured.profiler.budgetFrameMs.p95}`);
  assert(consoleErrors.length === 0,
    `browser console must remain clean; received ${consoleErrors.join(' | ')}`);

  const result = {
    passed: failures.length === 0,
    assertions,
    failures,
    consoleErrors,
    ...measured,
    ammoSpent,
    flashFrameRatio: measured.profile.flashFrames / measured.profile.frames,
    verdict: measured.profiler.budgetFrameMs.p95 <= 16.7
      ? `PASS: ${measured.profiler.budgetFrameMs.p95.toFixed(3)}ms p95 <= 16.700ms`
      : `FAIL: ${measured.profiler.budgetFrameMs.p95.toFixed(3)}ms p95 > 16.700ms`,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await browser.close();
}
