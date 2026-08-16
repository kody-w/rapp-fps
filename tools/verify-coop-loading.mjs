#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const TARGET = process.env.FPS_URL ?? 'http://127.0.0.1:5273/';
const browser = await chromium.launch();

async function resources(query, ready) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const scripts = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.endsWith('.js')) scripts.push(path.split('/').pop());
  });
  const url = new URL(TARGET);
  url.search = query;
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(ready, null, { timeout: 45_000 });
  await page.waitForTimeout(100);
  await context.close();
  return [...new Set(scripts)];
}

const menu = await resources('', () => window.__CAMPAIGN_MENU__?.state?.visible === true);
const single = await resources(
  '?mission=cargo-breach&campaignFixture=1',
  () => window.__FRAME_READY__ === true,
);
const coop = await resources(
  '?mission=cargo-breach&campaignFixture=1&coopFixture=1',
  () => window.__FRAME_READY__ === true && window.__COOP__?.state?.playerCount === 2,
);

const hasCoop = (scripts) => scripts.some((name) => name.startsWith('coop-'));
assert.equal(hasCoop(menu), false, `menu eagerly loaded co-op: ${menu.join(', ')}`);
assert.equal(hasCoop(single), false, `single-player eagerly loaded co-op: ${single.join(', ')}`);
assert.equal(hasCoop(coop), true, `co-op route did not load co-op chunk: ${coop.join(', ')}`);

console.log(JSON.stringify({
  passed: true,
  menu,
  single,
  coop,
}, null, 2));
await browser.close();
