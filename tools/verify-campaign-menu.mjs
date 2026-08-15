#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const TARGET = process.env.FPS_URL ?? 'http://127.0.0.1:5273/';
const OUT = process.env.MENU_OUT ?? 'shots/campaign-menu';
mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, 'menu.json'), { force: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
  ],
});
const errors = [];
const evidence = { target: TARGET, checks: [] };
let verdict = 'REFUSED';

function url(query = '') {
  const target = new URL(TARGET);
  target.search = query;
  return target.href;
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    if (!new URLSearchParams(location.search).has('play')) localStorage.clear();
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(url(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => (
    window.__CAMPAIGN_MENU__?.state?.visible === true
    || window.__FRAME_READY__ === true
  ), null, { timeout: 45_000 });
  assert(
    await page.evaluate(() => window.__CAMPAIGN_MENU__?.state?.visible === true),
    'window.__CAMPAIGN_MENU__ is missing; root booted gameplay instead of the menu',
  );

  const fresh = await page.evaluate(() => ({
    menu: window.__CAMPAIGN_MENU__.state,
    engineExists: Boolean(window.engine),
    canvasHidden: getComputedStyle(document.querySelector('#game')).visibility === 'hidden',
    activeElement: document.activeElement?.getAttribute('data-menu-action') ?? null,
    storage: { ...localStorage },
  }));
  assert.equal(fresh.engineExists, false, 'engine constructed behind the campaign menu');
  assert.equal(fresh.canvasHidden, true, 'game canvas is visible behind menu boot');
  assert.equal(fresh.menu.cards.length, 3);
  assert.deepEqual(
    fresh.menu.cards.map((card) => ({
      id: card.id,
      status: card.status,
      selectable: card.selectable,
    })),
    [
      { id: 'cargo-breach', status: 'current', selectable: true },
      { id: 'relay-blackout', status: 'locked', selectable: false },
      { id: 'foundry-last-light', status: 'locked', selectable: false },
    ],
  );
  assert.equal(fresh.activeElement, 'continue', 'Continue did not receive initial focus');
  evidence.checks.push({ name: 'fresh-menu', pass: true, fresh });
  await page.screenshot({ path: join(OUT, 'fresh-menu.png') });

  const beforeLocked = { url: page.url(), storage: fresh.storage };
  await page.locator('[data-mission-id="relay-blackout"]').click({ force: true });
  await page.waitForTimeout(100);
  const afterLocked = await page.evaluate(() => ({
    url: location.href,
    storage: { ...localStorage },
    engineExists: Boolean(window.engine),
    visible: window.__CAMPAIGN_MENU__.state.visible,
  }));
  assert.equal(afterLocked.url, beforeLocked.url);
  assert.deepEqual(afterLocked.storage, beforeLocked.storage);
  assert.equal(afterLocked.engineExists, false);
  assert.equal(afterLocked.visible, true);
  evidence.checks.push({ name: 'locked-inert', pass: true });

  await page.locator('[data-menu-action="continue"]').click();
  await page.waitForURL((current) => (
    current.searchParams.get('mission') === 'cargo-breach'
    && current.searchParams.get('play') === '1'
  ), { timeout: 10_000 });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });
  const deployed = await page.evaluate(() => ({
    menuExists: Boolean(window.__CAMPAIGN_MENU__),
    menuRoots: document.querySelectorAll('[data-campaign-menu]').length,
    engineExists: Boolean(window.engine),
    missionId: window.__CAMPAIGN__?.state?.missionId,
    hudObjective: document.querySelector('.hud-objective-title')?.textContent,
  }));
  assert.equal(deployed.menuExists, false);
  assert.equal(deployed.menuRoots, 0);
  assert.equal(deployed.engineExists, true);
  assert.equal(deployed.missionId, 'cargo-breach');
  assert.equal(deployed.hudObjective, 'SECURE THE CARGO BAY');
  evidence.checks.push({ name: 'continue-deploys', pass: true, deployed });
  await page.close();

  const fixture = await context.newPage();
  fixture.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  fixture.on('pageerror', (error) => errors.push(String(error)));
  await fixture.goto(url('?mission=relay-blackout&campaignFixture=1'), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await fixture.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });
  const fixtureState = await fixture.evaluate(() => ({
    menuRoots: document.querySelectorAll('[data-campaign-menu]').length,
    engineExists: Boolean(window.engine),
    missionId: window.__CAMPAIGN__?.state?.missionId,
    fixture: window.__CAMPAIGN__?.state?.fixture,
  }));
  assert.deepEqual(fixtureState, {
    menuRoots: 0,
    engineExists: true,
    missionId: 'relay-blackout',
    fixture: true,
  });
  evidence.checks.push({ name: 'fixture-bypass', pass: true, fixtureState });
  await fixture.close();

  assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
  verdict = 'PASS';
  console.log('CAMPAIGN MENU VERIFIED — boot gated, locks inert, Continue deploys.');
} catch (error) {
  evidence.failure = error instanceof Error ? error.stack : String(error);
  console.error(`CAMPAIGN MENU REFUSED — ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(OUT, 'menu.json'),
    JSON.stringify({ verdict, errors, ...evidence }, null, 2),
  );
  await browser.close();
}
