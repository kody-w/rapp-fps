#!/usr/bin/env node
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.goto('http://127.0.0.1:5282/src/weapons/test/shell.html', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.__SHELL_READY__ === true);
const result = await page.evaluate(() => window.__SHELL_RESULT__);
await page.screenshot({ path: 'shots/shell-end-on.png' });
await browser.close();
console.log(JSON.stringify({ ...result, errors }, null, 2));
if (result.status !== 'passed' || errors.length > 0) process.exit(1);
