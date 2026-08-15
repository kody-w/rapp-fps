#!/usr/bin/env node
/**
 * Black-box campaign acceptance for issue #70.
 *
 * This instrument is intentionally authored before production integration. It
 * drives the real root and only depends on browser-visible contracts: mission
 * URLs, the HUD, the existing engine event bus, persisted progression, and the
 * read-only campaign evidence seam.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const TARGET = process.env.FPS_URL ?? 'http://127.0.0.1:5273/';
const OUT = process.env.CAMPAIGN_OUT ?? 'shots/campaign';
const MISSIONS = [
  {
    id: 'cargo-breach',
    title: 'CARGO BREACH',
    objective: 'SECURE THE CARGO BAY',
  },
  {
    id: 'relay-blackout',
    title: 'RELAY BLACKOUT',
    objective: 'RESTORE THE RELAY',
  },
  {
    id: 'foundry-last-light',
    title: 'FOUNDRY LAST LIGHT',
    objective: 'SECURE THE FOUNDRY',
  },
];

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, 'campaign.json'), { force: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const errors = [];
const evidence = { target: TARGET, missions: [], progression: [] };

function missionUrl(id, fixture = false) {
  const url = new URL(TARGET);
  url.searchParams.set('mission', id);
  if (fixture) url.searchParams.set('campaignFixture', '1');
  return url.href;
}

async function ready(page) {
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });
  const hasCampaign = await page.evaluate(() => Boolean(window.__CAMPAIGN__?.state));
  assert(
    hasCampaign,
    'window.__CAMPAIGN__.state is missing; campaign behavior is unobservable',
  );
  await page.waitForFunction(() => window.__CAMPAIGN__?.state?.status === 'active', null, {
    timeout: 10_000,
  });
}

async function open(context, id, fixture = false) {
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(missionUrl(id, fixture), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await ready(page);
  return page;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const campaign = window.__CAMPAIGN__;
    const world = window.__LEVEL_STATIC_WORLD__;
    const hudObjective = document.querySelector('.hud-objective')?.textContent
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
    const boxes = world?.boxes?.map((box) => ({
      id: box.id,
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      surface: box.surface,
    })) ?? [];
    return {
      state: campaign?.state ?? null,
      mission: campaign?.mission
        ? {
          id: campaign.mission.id,
          title: campaign.mission.title,
          objective: campaign.mission.objective,
          playerSpawns: campaign.mission.playerSpawns,
          enemyCoverIds: campaign.mission.enemyCoverIds,
        }
        : null,
      hudObjective,
      bodyText: document.body.innerText.replace(/\s+/g, ' ').trim(),
      boxes,
      storage: { ...localStorage },
      hudRoots: document.querySelectorAll('[data-hud-root]').length,
      canvasCount: document.querySelectorAll('canvas#game').length,
    };
  });
}

function worldFingerprint(boxes) {
  return createHash('sha256').update(JSON.stringify(boxes)).digest('hex');
}

function assertMissionSnapshot(actual, expected) {
  assert(actual.state, 'window.__CAMPAIGN__.state is missing');
  assert(actual.mission, 'window.__CAMPAIGN__.mission is missing');
  assert.equal(actual.state.missionId, expected.id);
  assert.equal(actual.state.status, 'active');
  assert.equal(actual.state.missionCount, MISSIONS.length);
  assert.equal(actual.mission.id, expected.id);
  assert.equal(actual.mission.title, expected.title);
  assert.equal(actual.mission.objective.title, expected.objective);
  assert(
    actual.hudObjective.includes(expected.objective),
    `HUD objective does not identify ${expected.id}: "${actual.hudObjective}"`,
  );
  assert(
    Array.isArray(actual.mission.playerSpawns)
      && actual.mission.playerSpawns.length >= 2,
    `${expected.id} does not expose two future co-op spawn slots`,
  );
  assert(
    Array.isArray(actual.mission.enemyCoverIds)
      && actual.mission.enemyCoverIds.length > 0,
    `${expected.id} has no authored enemy cover ids`,
  );
  assert(actual.boxes.length > 0, `${expected.id} produced an empty StaticWorld`);
  assert.equal(actual.hudRoots, 1, `${expected.id} mounted ${actual.hudRoots} HUD roots`);
  assert.equal(actual.canvasCount, 1, `${expected.id} mounted ${actual.canvasCount} game canvases`);
}

function assertDistinct(values, label) {
  assert.equal(
    new Set(values).size,
    values.length,
    `${label} are not structurally distinct: ${values.join(', ')}`,
  );
}

async function emit(page, event, payload) {
  await page.evaluate(([name, value]) => {
    window.engine.bus.emit(name, value);
  }, [event, payload]);
}

async function clearProgress(context) {
  const page = await context.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate(() => localStorage.clear());
  await page.close();
}

let verdict = 'REFUSED';
try {
  const catalogContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await clearProgress(catalogContext);
  const storageBeforeFixture = await catalogContext.pages()[0]?.evaluate(
    () => ({ ...localStorage }),
  ) ?? {};

  const fingerprints = [];
  const imageHashes = [];
  for (const expected of MISSIONS) {
    const page = await open(catalogContext, expected.id, true);
    const actual = await snapshot(page);
    assertMissionSnapshot(actual, expected);

    const image = await page.screenshot({
      path: join(OUT, `${expected.id}.png`),
      animations: 'disabled',
    });
    const fingerprint = worldFingerprint(actual.boxes);
    const imageHash = createHash('sha256').update(image).digest('hex');
    fingerprints.push(fingerprint);
    imageHashes.push(imageHash);
    evidence.missions.push({
      id: expected.id,
      worldBoxes: actual.boxes.length,
      worldFingerprint: fingerprint,
      screenshotSha256: imageHash,
      playerSpawnSlots: actual.mission.playerSpawns.length,
      enemyCoverIds: actual.mission.enemyCoverIds.length,
      hudObjective: actual.hudObjective,
    });
    await page.close();
  }
  assertDistinct(fingerprints, 'mission worlds');
  assertDistinct(imageHashes, 'cold mission screenshots');

  // Prove the uniqueness oracle itself can go red.
  let duplicateRejected = false;
  try {
    assertDistinct([fingerprints[0], fingerprints[0], fingerprints[2]], 'mutated mission worlds');
  } catch {
    duplicateRejected = true;
  }
  assert(duplicateRejected, 'world-distinctness negative control did not fail');

  const fixtureStorage = await catalogContext.newPage();
  await fixtureStorage.goto(TARGET, { waitUntil: 'domcontentloaded' });
  const storageAfterFixture = await fixtureStorage.evaluate(() => ({ ...localStorage }));
  assert.deepEqual(
    storageAfterFixture,
    storageBeforeFixture,
    'campaignFixture mission jumps forged persisted completion',
  );
  await fixtureStorage.close();
  await catalogContext.close();

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await clearProgress(context);

  // A fresh profile may not enter a locked finale through a deep link.
  const locked = await open(context, MISSIONS[2].id);
  const lockedSnapshot = await snapshot(locked);
  assert.equal(lockedSnapshot.state.missionId, MISSIONS[0].id);
  assert.equal(new URL(locked.url()).searchParams.get('mission'), MISSIONS[0].id);
  evidence.progression.push({
    check: 'locked-deep-link',
    requested: MISSIONS[2].id,
    resolved: lockedSnapshot.state.missionId,
  });
  await locked.close();

  let page = await open(context, MISSIONS[0].id);
  const firstUrl = page.url();

  // Lethal player damage must reload the same checkpoint, not unlock or advance.
  await emit(page, 'combat:damage', {
    id: 'player',
    amount: 100,
    health: 0,
    maxHealth: 100,
    lethal: true,
    direction: { x: 0, y: 0, z: 1 },
    point: { x: 0, y: 1, z: 0 },
  });
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  await ready(page);
  const retry = await snapshot(page);
  assert.equal(retry.state.missionId, MISSIONS[0].id);
  assert.equal(retry.state.furthestUnlockedIndex, 0);
  assert.equal(new URL(page.url()).searchParams.get('mission'), MISSIONS[0].id);
  evidence.progression.push({
    check: 'death-retry',
    before: firstUrl,
    after: page.url(),
    missionId: retry.state.missionId,
  });

  // The real elimination event advances and persists exactly one mission.
  for (let index = 0; index < MISSIONS.length - 1; index += 1) {
    const current = MISSIONS[index];
    const next = MISSIONS[index + 1];
    await emit(page, 'combat:elimination', { id: 'enemy-1', label: 'TARGET DOWN' });
    await page.waitForFunction(
      (missionId) => window.__CAMPAIGN__?.state?.missionId === missionId,
      next.id,
      { timeout: 10_000 },
    );
    await ready(page);
    const advanced = await snapshot(page);
    assert.equal(advanced.state.missionId, next.id);
    assert.equal(advanced.state.furthestUnlockedIndex, index + 1);
    assert.equal(new URL(page.url()).searchParams.get('mission'), next.id);
    assert.equal(advanced.hudRoots, 1);
    assert.equal(advanced.canvasCount, 1);
    evidence.progression.push({
      check: 'advance',
      from: current.id,
      to: advanced.state.missionId,
      furthestUnlockedIndex: advanced.state.furthestUnlockedIndex,
    });

    // Reload hydration must retain the unlocked/current mission without
    // duplicate roots, input listeners, or a fallback to Cargo Breach.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    const hydrated = await snapshot(page);
    assert.equal(hydrated.state.missionId, next.id);
    assert.equal(hydrated.state.furthestUnlockedIndex, index + 1);
    assert.equal(hydrated.hudRoots, 1);
    assert.equal(hydrated.canvasCount, 1);
  }

  await emit(page, 'combat:elimination', { id: 'enemy-1', label: 'TARGET DOWN' });
  await page.waitForFunction(() => window.__CAMPAIGN__?.state?.status === 'complete', null, {
    timeout: 10_000,
  });
  const finale = await snapshot(page);
  assert.equal(finale.state.missionId, MISSIONS[2].id);
  assert.equal(finale.state.status, 'complete');
  assert.equal(finale.state.furthestUnlockedIndex, MISSIONS.length - 1);
  assert.equal(new URL(page.url()).searchParams.get('mission'), MISSIONS[2].id);
  assert(
    documentText(finale).includes('CAMPAIGN COMPLETE'),
    'final mission did not present an explicit CAMPAIGN COMPLETE state',
  );
  evidence.progression.push({
    check: 'finale',
    missionId: finale.state.missionId,
    status: finale.state.status,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__CAMPAIGN__?.state?.status === 'complete', null, {
    timeout: 45_000,
  });
  const completedReload = await snapshot(page);
  assert.equal(completedReload.state.missionId, MISSIONS[2].id);
  assert.equal(completedReload.state.status, 'complete');
  assert.equal(completedReload.hudRoots, 1);
  assert.equal(completedReload.canvasCount, 1);
  await page.close();
  await context.close();

  assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
  verdict = 'PASS';
  console.log('CAMPAIGN VERIFIED — 3 distinct missions, retry, progression, hydration, and finale passed.');
} catch (error) {
  evidence.failure = error instanceof Error ? error.stack : String(error);
  console.error(`CAMPAIGN REFUSED — ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(OUT, 'campaign.json'),
    JSON.stringify({ verdict, errors, ...evidence }, null, 2),
  );
  await browser.close();
}

function documentText(snapshot) {
  return `${snapshot.bodyText} ${snapshot.state?.message ?? ''}`.toUpperCase();
}
