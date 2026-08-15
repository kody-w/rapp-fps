#!/usr/bin/env node
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.goto('http://127.0.0.1:5282/src/game/test/input.html', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.__INPUT_READY__ === true);
const result = await page.evaluate(() => window.__INPUT_RESULT__);
await browser.close();
console.log(JSON.stringify({ ...result, errors }, null, 2));
if (result.status !== 'passed' || errors.length > 0) process.exit(1);
