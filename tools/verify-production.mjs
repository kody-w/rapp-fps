/**
 * Production-root integration evidence. — #21
 *
 * This drives the same `/` entry point a player opens, never a subsystem
 * harness. It proves the merged libraries are registered, their observable
 * event seams work without importing one another, audio obeys the gesture
 * boundary, and disposal removes subscriptions/DOM.
 *
 * Negative controls reload the real dev root with each registration omitted.
 * The same assertion used for the positive path must fail and name exactly the
 * missing subsystem; a test that cannot fail on omission proves nothing.
 */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const TARGET = process.env.FPS_URL ?? 'http://127.0.0.1:5273/';

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});

const errors = [];
async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  const target = new URL(TARGET);
  const requested = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  for (const [key, value] of requested) target.searchParams.set(key, value);
  target.searchParams.set('play', '1');
  await page.goto(target.href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });
  return page;
}

function assertRegistered(snapshot) {
  assert.equal(snapshot.fx, true, 'fx registration missing');
  assert.equal(snapshot.audio, true, 'audio registration missing');
  assert.equal(snapshot.hud, true, 'hud registration missing');
  assert.equal(snapshot.hudRoots, 1, `expected one HUD root, got ${snapshot.hudRoots}`);
}

async function snapshot(page) {
  return page.evaluate(() => ({
    fx: Boolean(window.engine.get('fx')),
    audio: Boolean(window.engine.get('audio')),
    hud: Boolean(window.engine.get('hud')),
    hudRoots: document.querySelectorAll('[data-hud-root]').length,
  }));
}

try {
  const page = await open();
  const registered = await snapshot(page);
  assertRegistered(registered);

  const bfcache = await page.evaluate(async () => {
    const before = {
      hudRoots: document.querySelectorAll('[data-hud-root]').length,
      audioState: window.engine.get('audio').status.state,
    };
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      before,
      after: {
        hudRoots: document.querySelectorAll('[data-hud-root]').length,
        audioState: window.engine.get('audio').status.state,
      },
    };
  });
  assert.deepEqual(bfcache.after, bfcache.before, 'BFCache cycle disposed the live app');

  const preArm = await page.evaluate(() => {
    const { engine, THREE } = window;
    const audio = engine.get('audio');
    const fx = engine.get('fx');
    const beforeDropped = audio.status.droppedWhileUnarmed;
    engine.bus.emit('weapon:fired', {
      origin: new THREE.Vector3(0, 1.4, 0),
      direction: new THREE.Vector3(0, 0, -1),
      weapon: 'integration-probe',
      spread: 0,
    });
    return {
      audioState: audio.status.state,
      dropped: audio.status.droppedWhileUnarmed - beforeDropped,
      flashIntensity: fx.flash.light.intensity,
      prompt: document.querySelector('.hud-interaction-action')?.textContent,
      binding: document.querySelector('.hud-interaction-binding')?.textContent,
    };
  });
  assert.equal(preArm.audioState, 'unarmed');
  assert.equal(preArm.dropped, 1, 'pre-arm event was queued or ignored silently');
  assert(preArm.flashIntensity > 0, 'WeaponFired did not reach CombatFX');
  assert.equal(preArm.prompt, 'DEPLOY');
  assert.equal(preArm.binding, 'CLICK');

  await page.locator('#game').click({ position: { x: 40, y: 40 } });
  await page.waitForFunction(() => window.engine.get('audio').status.state === 'armed', null, {
    timeout: 10_000,
  });

  const suspended = await page.evaluate(async () => {
    const audio = window.__INTEGRATION__.audio;
    // Private in TypeScript, intentionally reached only by this black-box
    // lifecycle verifier to simulate a browser interruption.
    await audio.context.suspend();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      state: audio.status.state,
      prompt: document.querySelector('.hud-interaction-action')?.textContent,
    };
  });
  assert.equal(suspended.state, 'suspended');
  assert.equal(suspended.prompt, 'RESUME');
  await page.locator('#game').click({ position: { x: 42, y: 42 } });
  await page.waitForFunction(() => window.engine.get('audio').status.state === 'armed', null, {
    timeout: 10_000,
  });

  const eventResult = await page.evaluate(async () => {
    const { engine, THREE } = window;
    const fx = engine.get('fx');
    const beforeParticles = fx.getParticleCount();

    engine.bus.emit('weapon:status', {
      ammo: 17,
      reserve: 63,
      magazineSize: 30,
      reloading: false,
      spread: 0.4,
      aim: 0.25,
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const health = () => document.querySelector('.hud-health-value')?.textContent;
    const ammo = () => document.querySelector('.hud-ammo-value')?.textContent;
    const beforeEnemy = health();
    engine.bus.emit('combat:damage', {
      id: 'enemy-1',
      amount: 20,
      point: new THREE.Vector3(),
      direction: new THREE.Vector3(-1, 0, 0),
      lethal: false,
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterEnemy = health();

    engine.bus.emit('combat:damage', {
      id: 'player',
      amount: 27,
      health: 73,
      maxHealth: 100,
      point: new THREE.Vector3(),
      direction: new THREE.Vector3(-1, 0, 0),
      lethal: false,
    });
    engine.bus.emit('bullet:impact', {
      point: new THREE.Vector3(0, 1.2, -8),
      normal: new THREE.Vector3(0, 0, 1),
      material: 'concrete',
      distance: 8,
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    return {
      audioState: engine.get('audio').status.state,
      ammo: ammo(),
      enemyHealthBefore: beforeEnemy,
      enemyHealthAfter: afterEnemy,
      playerHealthAfter: health(),
      damageVisible: document.querySelector('.hud-damage')?.classList.contains('is-visible'),
      particleDelta: fx.getParticleCount() - beforeParticles,
      decalCount: fx.getDecalCount(),
    };
  });

  assert.equal(eventResult.audioState, 'armed');
  assert.equal(eventResult.ammo, '17');
  assert.equal(eventResult.enemyHealthAfter, eventResult.enemyHealthBefore);
  assert.equal(eventResult.playerHealthAfter, '73');
  assert.equal(eventResult.damageVisible, true);
  assert(eventResult.particleDelta > 0, 'BulletImpact produced no particles');
  assert(eventResult.decalCount > 0, 'BulletImpact produced no decal');

  const disposed = await page.evaluate(() => {
    const audio = window.engine.get('audio');
    const fx = window.engine.get('fx');
    const countsBefore = {
      particles: fx.getParticleCount(),
      decals: fx.getDecalCount(),
    };
    window.__INTEGRATION__.dispose();
    window.engine.bus.emit('bullet:impact', {
      point: new window.THREE.Vector3(),
      normal: new window.THREE.Vector3(0, 1, 0),
      material: 'concrete',
    });
    return {
      hudRoots: document.querySelectorAll('[data-hud-root]').length,
      audioState: audio.status.state,
      countsBefore,
      countsAfter: {
        particles: fx.getParticleCount(),
        decals: fx.getDecalCount(),
      },
    };
  });
  assert.equal(disposed.hudRoots, 0);
  assert.equal(disposed.audioState, 'closed');
  assert.deepEqual(disposed.countsAfter, disposed.countsBefore);
  await page.locator('#game').click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(50);
  const afterDisposedClick = await page.evaluate(() => ({
    audioState: window.__INTEGRATION__.audio.status.state,
    hudRoots: document.querySelectorAll('[data-hud-root]').length,
  }));
  assert.deepEqual(afterDisposedClick, { audioState: 'closed', hudRoots: 0 });
  await page.close();

  const mutationFailures = {};
  for (const name of ['fx', 'audio', 'hud']) {
    const mutationPage = await open(`?integrationOmit=${name}`);
    const mutation = await snapshot(mutationPage);
    try {
      assertRegistered(mutation);
      mutationFailures[name] = null;
    } catch (error) {
      mutationFailures[name] = String(error.message);
    }
    assert(
      mutationFailures[name]?.includes(`${name} registration missing`)
      || (name === 'hud' && mutationFailures[name]?.includes('hud registration missing')),
      `${name} omission did not fail the production registration assertion`,
    );
    if (name === 'audio') {
      await mutationPage.locator('#game').click({ position: { x: 20, y: 20 } });
      await mutationPage.waitForTimeout(50);
      const omittedAudio = await mutationPage.evaluate(() => ({
        internalState: window.__INTEGRATION__.audio.status.state,
        documentState: document.documentElement.dataset.audio,
      }));
      assert.deepEqual(
        omittedAudio,
        { internalState: 'unarmed', documentState: 'omitted' },
        'omitted audio still installed gesture behavior',
      );
    }
    await mutationPage.close();
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    passed: true,
    registered,
    preArm,
    suspended,
    eventResult,
    bfcache,
    disposed,
    afterDisposedClick,
    mutationFailures,
    consoleErrors: errors,
  }, null, 2));
} finally {
  await browser.close();
}
