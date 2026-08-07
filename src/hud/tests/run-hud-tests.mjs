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

  const enemyDamage = await page.evaluate(async () => {
    const harness = window.__HUD_HARNESS__;
    await harness.setState('hip');
    const indicator = document.querySelector('.hud-damage');
    const health = document.querySelector('.hud-health-value');
    if (!(indicator instanceof HTMLElement) || !(health instanceof HTMLElement)) {
      throw new Error('HUD damage presentation is missing');
    }
    const before = {
      health: health.textContent,
      indicatorVisible: indicator.classList.contains('is-visible'),
      quadrant: indicator.dataset.quadrant ?? null,
      angle: indicator.style.getPropertyValue('--damage-angle'),
    };
    const after = await harness.emitDamage(
      'enemy-17',
      { x: -1, y: 0, z: 0 },
      5,
    );
    return { before, after };
  });
  assert.deepEqual(
    enemyDamage.after,
    enemyDamage.before,
    'Damage for a non-player character changed the player HUD',
  );
  assert.equal(enemyDamage.after.health, '100');
  assert.equal(enemyDamage.after.indicatorVisible, false);

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
    observer.observe(live, { characterData: true, subtree: true });

    await window.__HUD_HARNESS__.emitElimination('TARGET DOWN');
    const afterFirstElimination = mutations;
    await window.__HUD_HARNESS__.waitFrames(20);
    const afterFirstEliminationFrames = mutations;

    await window.__HUD_HARNESS__.emitElimination('TARGET DOWN');
    const afterSecondElimination = mutations;
    await window.__HUD_HARNESS__.waitFrames(20);
    const afterSecondEliminationFrames = mutations;

    await window.__HUD_HARNESS__.emitReloadStart();
    const afterFirstReload = mutations;
    await window.__HUD_HARNESS__.waitFrames(20);
    const afterFirstReloadFrames = mutations;

    await window.__HUD_HARNESS__.emitReloadStart();
    const afterSecondReload = mutations;
    await window.__HUD_HARNESS__.waitFrames(20);
    const afterSecondReloadFrames = mutations;

    observer.disconnect();
    return {
      afterFirstElimination,
      afterFirstEliminationFrames,
      afterSecondElimination,
      afterSecondEliminationFrames,
      afterFirstReload,
      afterFirstReloadFrames,
      afterSecondReload,
      afterSecondReloadFrames,
      message: live instanceof HTMLElement ? live.dataset.message : undefined,
      visible: document.querySelector('.hud-elimination')?.classList.contains('is-visible'),
    };
  });
  assert.equal(aria.visible, true, 'elimination event did not show confirmation');
  assert.equal(aria.afterFirstElimination, 1);
  assert.equal(aria.afterFirstEliminationFrames, 1);
  assert.equal(aria.afterSecondElimination, 2);
  assert.equal(aria.afterSecondEliminationFrames, 2);
  assert.equal(aria.afterFirstReload, 3);
  assert.equal(aria.afterFirstReloadFrames, 3);
  assert.equal(aria.afterSecondReload, 4);
  assert.equal(
    aria.afterSecondReloadFrames,
    4,
    'ARIA live region changed during presentation-only animation frames',
  );
  assert.equal(aria.message, 'Reloading');

  const lifecycle = await page.evaluate(
    () => window.__HUD_HARNESS__.remount(),
  );
  assert.equal(lifecycle.rootCount, 1, 'dispose/init created duplicate HUD roots');
  assert.equal(lifecycle.nodeCount, growth.before, 'remounted HUD structure changed');
  assert.equal(lifecycle.ammo, '05', 'ammo was blank after remount');
  assert.equal(lifecycle.health, '18', 'health was blank after remount');
  assert.equal(lifecycle.reticle, 'ads', 'reticle state was blank after remount');
  assert.equal(lifecycle.objective, 'LIFECYCLE CHECK', 'objective was blank after remount');

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

  const mutationPage = await open('?state=hip&mutation=no-reuse');
  const mutationGrowth = await mutationPage.evaluate(
    () => window.__HUD_HARNESS__.stressUpdates(1_000),
  );
  let mutationFailure = '';
  try {
    assert.equal(
      mutationGrowth.after,
      mutationGrowth.before,
      `DOM node count grew from ${mutationGrowth.before} to ${mutationGrowth.after} `
        + 'after 1,000 updates in the harness no-reuse mutation control',
    );
  } catch (error) {
    assert.ok(error instanceof AssertionError, 'mutation control did not produce an assertion');
    mutationFailure = error.message;
  }
  assert.notEqual(mutationFailure, '', 'mutation control unexpectedly passed');
  assert.equal(mutationGrowth.before, 43, 'mutation-control baseline changed');
  assert.equal(mutationGrowth.after, 1_043, 'mutation control did not leak one node per update');
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
    playerDamageFilter: enemyDamage,
    directionalMapping: directions,
    ariaLive: aria,
    lifecycle,
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
