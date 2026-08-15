#!/usr/bin/env node
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

await page.goto('http://127.0.0.1:5282/src/game/test/combat.html', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.__COMBAT_READY__ === true);
const result = await page.evaluate(() => window.__COMBAT_RESULT__);
await browser.close();

console.log(JSON.stringify({ ...result, errors }, null, 2));
if (result.status !== 'passed' || errors.length > 0) process.exit(1);
