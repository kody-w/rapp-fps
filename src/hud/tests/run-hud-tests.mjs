import assert, { AssertionError } from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE_URL = process.env.HUD_URL ?? 'http://127.0.0.1:5332/harness.html';
const EVIDENCE = fileURLToPath(new URL('../evidence/test-results.json', import.meta.url));
mkdirSync(dirname(EVIDENCE), { recursive: true });

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

async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${BASE_URL}${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });
  return page;
}

try {
  const page = await open('?state=hip');

  const growth = await page.evaluate(
    () => window.__HUD_HARNESS__.stressUpdates(1_000),
  );
  assert.equal(
    growth.after,
    growth.before,
    `DOM node count grew from ${growth.before} to ${growth.after} after 1,000 updates`,
  );

  const directions = await page.evaluate(async () => {
    const harness = window.__HUD_HARNESS__;
    return {
      front: await harness.mapDamage({ x: 0, y: 0, z: -1 }),
      right: await harness.mapDamage({ x: 1, y: 0, z: 0 }),
      rear: await harness.mapDamage({ x: 0, y: 0, z: 1 }),
      left: await harness.mapDamage({ x: -1, y: 0, z: 0 }),
      yawedFront: await harness.mapDamage({ x: -1, y: 0, z: 0 }, Math.PI / 2),
    };
  });
  assert.equal(directions.front.quadrant, 'top');
  assert.equal(directions.right.quadrant, 'right');
  assert.equal(directions.rear.quadrant, 'bottom');
  assert.equal(directions.left.quadrant, 'left');
  assert.equal(
    directions.yawedFront.quadrant,
    'top',
    'world-left should become screen-front after a +90° camera yaw',
  );

  const aria = await page.evaluate(async () => {
    const live = document.querySelector('.hud-live');
    if (!live) throw new Error('ARIA live region is missing');
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    await window.__HUD_HARNESS__.emitElimination('TARGET DOWN');
    const afterEvent = mutations;
    await window.__HUD_HARNESS__.waitFrames(40);
    const afterFrames = mutations;
    observer.disconnect();
    return {
      afterEvent,
      afterFrames,
      text: live.textContent,
      visible: document.querySelector('.hud-elimination')?.classList.contains('is-visible'),
    };
  });
  assert.equal(aria.text, 'TARGET DOWN');
  assert.equal(aria.visible, true, 'elimination event did not show confirmation');
  assert.equal(aria.afterEvent, 1, 'one semantic event should produce one live-region update');
  assert.equal(
    aria.afterFrames,
    aria.afterEvent,
    'ARIA live region changed during presentation-only animation frames',
  );

  const debugAbsent = await page.evaluate(
    () => document.querySelector('[data-hud-debug]') === null,
  );
  assert.equal(debugAbsent, true, 'debug overlay exists without hudDebug=1');
  await page.close();

  const debugPage = await open('?state=objective&hudDebug=1');
  await debugPage.waitForFunction(
    () => window.engine.profiler.snapshot().budgetFrameMs.samples >= 3,
    null,
    { timeout: 45_000 },
  );
  await debugPage.waitForTimeout(300);
  const debug = await debugPage.evaluate(() => {
    const root = document.querySelector('[data-hud-debug]');
    return {
      exists: root !== null,
      gpu: root?.querySelector('[data-debug-gpu]')?.textContent,
      cpu: root?.querySelector('[data-debug-cpu]')?.textContent,
      paired: root?.querySelector('[data-debug-paired]')?.textContent,
      draws: root?.querySelector('[data-debug-draws]')?.textContent,
      overBudget: root?.getAttribute('data-over-budget'),
      text: root?.textContent ?? '',
    };
  });
  assert.equal(debug.exists, true, 'hudDebug=1 did not mount debug overlay');
  assert.match(debug.gpu ?? '', /ms$/);
  assert.match(debug.cpu ?? '', /ms$/);
  assert.match(debug.paired ?? '', /ms$/);
  assert.match(debug.draws ?? '', /^\d+$/);
  assert.match(debug.overBudget ?? '', /^(true|false)$/);
  assert.match(debug.text, /overBudget (TRUE|FALSE)/);
  await debugPage.close();

  const mutationPage = await open('?state=hip&reuse=0');
  const mutationGrowth = await mutationPage.evaluate(
    () => window.__HUD_HARNESS__.stressUpdates(1_000),
  );
  let mutationFailure = '';
  try {
    assert.equal(
      mutationGrowth.after,
      mutationGrowth.before,
      `DOM node count grew from ${mutationGrowth.before} to ${mutationGrowth.after} `
        + 'after 1,000 updates with node reuse disabled',
    );
  } catch (error) {
    assert.ok(error instanceof AssertionError, 'mutation control did not produce an assertion');
    mutationFailure = error.message;
  }
  assert.notEqual(mutationFailure, '', 'mutation control unexpectedly passed');
  assert.ok(
    mutationGrowth.after - mutationGrowth.before >= 1_000,
    'disabled reuse did not leak at least one node per update',
  );
  await mutationPage.close();

  assert.deepEqual(consoleErrors, [], `browser console errors:\n${consoleErrors.join('\n')}`);

  const report = {
    passed: true,
    domGrowth: {
      updates: 1_000,
      before: growth.before,
      after: growth.after,
      growth: growth.after - growth.before,
    },
    directionalMapping: directions,
    ariaLive: aria,
    debugGate: {
      absentWithoutFlag: debugAbsent,
      presentWithFlag: debug.exists,
      fields: debug,
    },
    mutationControl: {
      before: mutationGrowth.before,
      after: mutationGrowth.after,
      assertionFailure: mutationFailure,
    },
    consoleErrors,
  };
  writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
