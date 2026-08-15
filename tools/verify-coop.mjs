#!/usr/bin/env node
/**
 * Black-box couch co-op acceptance for issue #71.
 *
 * Authored before integration. The fixture query substitutes a scripted
 * standard gamepad but drives the same slot input, motors, weapons, combat,
 * cameras, render coordinator, and campaign root production uses.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const TARGET = process.env.FPS_URL ?? 'http://127.0.0.1:5273/';
const OUT = process.env.COOP_OUT ?? 'shots/coop';

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, 'coop.json'), { force: true });

function fixtureUrl() {
  const url = new URL(TARGET);
  url.searchParams.set('mission', 'cargo-breach');
  url.searchParams.set('campaignFixture', '1');
  url.searchParams.set('coopFixture', '1');
  return url.href;
}

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

const evidence = { target: TARGET, checks: [] };
const pass = (name, detail, data) => {
  evidence.checks.push({ name, status: 'pass', detail, ...(data ? { data } : {}) });
};

async function snapshot() {
  return page.evaluate(() => window.__COOP__?.state ?? null);
}

function player(state, id) {
  const found = state.players.find((entry) => entry.id === id);
  assert(found, `co-op state is missing ${id}`);
  return found;
}

function distance(a, b) {
  return Math.hypot(
    a.position.x - b.position.x,
    a.position.y - b.position.y,
    a.position.z - b.position.z,
  );
}

let verdict = 'REFUSED';
try {
  await page.goto(fixtureUrl(), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });
  const hasCoop = await page.evaluate(() => (
    Boolean(window.__COOP__?.state)
    && Boolean(window.__COOP_TEST__)
  ));
  assert(
    hasCoop,
    'window.__COOP__.state / window.__COOP_TEST__ are missing; couch co-op is unobservable',
  );
  await page.waitForFunction(() => (
    window.__COOP__.state.active
    && window.__COOP__.state.playerCount === 2
  ), null, { timeout: 10_000 });

  const initial = await snapshot();
  assert.equal(initial.mode, 'horizontal-split');
  assert.equal(initial.playerCount, 2);
  assert.equal(initial.friendlyFire, false);
  assert.equal(initial.joinPolicy, 'checkpoint-only');
  assert.equal(initial.revivePolicy, 'checkpoint-respawn');
  assert.deepEqual(
    initial.simulation,
    { worlds: 1, campaigns: 1, enemies: 1 },
    'co-op duplicated world/campaign/enemy simulation per viewport',
  );
  assert.equal(initial.viewports.length, 2);
  const [top, bottom] = initial.viewports;
  assert.equal(top.width, bottom.width);
  assert.equal(top.height + bottom.height, initial.backingHeight);
  assert.equal(top.y, bottom.height);
  assert.equal(bottom.y, 0);
  pass('composition', 'two slots share exactly one world, campaign, and enemy', {
    viewports: initial.viewports,
    simulation: initial.simulation,
  });

  const initialFrame = await page.screenshot({ path: join(OUT, 'split.png') });
  const half = Math.floor(720 / 2);
  const topPixels = await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: half },
  });
  const bottomPixels = await page.screenshot({
    clip: { x: 0, y: half, width: 1280, height: 720 - half },
  });
  const topHash = createHash('sha256').update(topPixels).digest('hex');
  const bottomHash = createHash('sha256').update(bottomPixels).digest('hex');
  assert.notEqual(topHash, bottomHash, 'both viewport halves rendered the same camera');
  pass('camera-pixels', 'top and bottom halves render distinct camera images', {
    frameBytes: initialFrame.length,
    topHash,
    bottomHash,
  });

  await page.evaluate(() => window.__COOP_TEST__.neutral());
  const beforeMove = await snapshot();
  await page.evaluate(() => window.__COOP_TEST__.setAxes([0, -1, 0, 0]));
  await page.waitForTimeout(1_000);
  await page.evaluate(() => window.__COOP_TEST__.neutral());
  await page.waitForTimeout(100);
  const afterMove = await snapshot();
  const p1Move = distance(player(beforeMove, 'player-1'), player(afterMove, 'player-1'));
  const p2Move = distance(player(beforeMove, 'player-2'), player(afterMove, 'player-2'));
  assert(p2Move > 1, `P2 moved only ${p2Move.toFixed(3)} m under full stick`);
  assert(p1Move < 0.2, `P1 moved ${p1Move.toFixed(3)} m under P2-only input`);
  pass('move-isolation', 'P2 gamepad movement changed only P2', { p1Move, p2Move });

  const beforeLook = await snapshot();
  await page.evaluate(() => window.__COOP_TEST__.setAxes([0, 0, 1, 0]));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__COOP_TEST__.neutral());
  await page.waitForTimeout(100);
  const afterLook = await snapshot();
  const p1Yaw = Math.abs(
    player(afterLook, 'player-1').yaw - player(beforeLook, 'player-1').yaw,
  );
  const p2Yaw = Math.abs(
    player(afterLook, 'player-2').yaw - player(beforeLook, 'player-2').yaw,
  );
  assert(p2Yaw > 0.2, `P2 yaw changed only ${p2Yaw.toFixed(3)} rad`);
  assert(p1Yaw < 0.03, `P1 yaw changed ${p1Yaw.toFixed(3)} rad under P2 look`);
  pass('look-isolation', 'P2 right stick changed only P2 camera', { p1Yaw, p2Yaw });

  const beforeFire = await snapshot();
  await page.evaluate(() => window.__COOP_TEST__.setButton('fire', true));
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__COOP_TEST__.setButton('fire', false));
  await page.waitForTimeout(100);
  const afterFire = await snapshot();
  const p1BeforeFire = player(beforeFire, 'player-1');
  const p2BeforeFire = player(beforeFire, 'player-2');
  const p1AfterFire = player(afterFire, 'player-1');
  const p2AfterFire = player(afterFire, 'player-2');
  assert(p2AfterFire.shotsFired > p2BeforeFire.shotsFired, 'P2 trigger fired no rounds');
  assert(p2AfterFire.ammo < p2BeforeFire.ammo, 'P2 trigger consumed no P2 ammo');
  assert.equal(p1AfterFire.shotsFired, p1BeforeFire.shotsFired);
  assert.equal(p1AfterFire.ammo, p1BeforeFire.ammo);
  pass('weapon-isolation', 'P2 fire changed only P2 weapon state');

  const beforeDamage = await snapshot();
  await page.evaluate(() => window.__COOP_TEST__.damagePlayer('player-2', 25));
  await page.waitForTimeout(50);
  const afterDamage = await snapshot();
  assert.equal(
    player(afterDamage, 'player-2').health,
    player(beforeDamage, 'player-2').health - 25,
  );
  assert.equal(
    player(afterDamage, 'player-1').health,
    player(beforeDamage, 'player-1').health,
  );
  await page.evaluate(() => window.__COOP_TEST__.damagePlayer('player-2', 100));
  await page.waitForTimeout(50);
  const afterP2Death = await snapshot();
  assert.equal(player(afterP2Death, 'player-2').alive, false);
  assert.equal(player(afterP2Death, 'player-1').alive, true);
  assert.equal(afterP2Death.campaignTransitioning, false);
  pass('health-isolation', 'P2 damage/death did not damage P1 or end the mission');

  const beforeLeave = await snapshot();
  await page.evaluate(() => window.__COOP_TEST__.leavePlayer2());
  await page.waitForFunction(() => window.__COOP__.state.playerCount === 1);
  const afterLeave = await snapshot();
  assert.equal(afterLeave.mode, 'single-player');
  assert.equal(afterLeave.viewports.length, 1);
  assert.equal(
    player(afterLeave, 'player-1').health,
    player(beforeLeave, 'player-1').health,
  );
  await page.evaluate(() => window.__COOP_TEST__.joinPlayer2());
  await page.waitForFunction(() => window.__COOP__.state.playerCount === 2);
  const afterRejoin = await snapshot();
  assert.equal(player(afterRejoin, 'player-2').alive, true);
  assert.equal(player(afterRejoin, 'player-2').health, 100);
  pass('checkpoint-join-leave', 'P2 left/rejoined without corrupting P1');

  await page.evaluate(() => window.__COOP_TEST__.disconnect());
  await page.waitForTimeout(50);
  const disconnected = await snapshot();
  assert.equal(player(disconnected, 'player-2').connected, false);
  assert.deepEqual(player(disconnected, 'player-2').input, {
    move: { x: 0, y: 0 },
    look: { x: 0, y: 0 },
    fire: false,
    aim: false,
  });
  assert.equal(player(disconnected, 'player-1').alive, true);
  pass('disconnect', 'disconnect neutralized P2 and preserved P1');

  assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
  verdict = 'PASS';
  console.log('COUCH CO-OP VERIFIED — two independent slots, one shared mission, split presentation.');
} catch (error) {
  evidence.failure = error instanceof Error ? error.stack : String(error);
  console.error(`COUCH CO-OP REFUSED — ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(OUT, 'coop.json'),
    JSON.stringify({ verdict, errors, ...evidence }, null, 2),
  );
  await browser.close();
}
