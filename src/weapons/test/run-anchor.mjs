/**
 * Playwright runner for the DUSKLINE A7 anchor + resource-ceiling fixture
 * (Refs #59). Loads the renderer-free browser harness through the dev server,
 * reads its published result and exits non-zero unless every anchor/resource
 * check passes. Pass an explicit --url rooted in this clone; harness default
 * ports have previously validated the wrong branch.
 *
 *   npm exec -- vite <repo> --host 127.0.0.1 --port 5285 --strictPort
 *   node src/weapons/test/run-anchor.mjs --url=http://127.0.0.1:5285/src/weapons/test/anchor.html
 */

import { chromium } from 'playwright';

const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const url = urlArg?.slice('--url='.length)
  ?? 'http://127.0.0.1:5285/src/weapons/test/anchor.html';

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});

let result;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__ANCHOR_RESULT__ !== undefined, null, { timeout: 60_000 });
  result = await page.evaluate(() => window.__ANCHOR_RESULT__);
} finally {
  await browser.close();
}

const pass = result.pass && pageErrors.length === 0;
console.log(JSON.stringify({ url, pageErrors, ...result }, null, 2));
process.exit(pass ? 0 : 1);
