/**
 * Playwright runner for the weapon subsystem CPU microbenchmark (#37). Measures
 * the subsystem's amortised per-rendered-frame CPU cost in-browser, excluding
 * rendering, and exits non-zero unless it fits the 0.25 ms budget. Pass an
 * explicit --url.
 *
 *   node src/weapons/test/run-bench.mjs --url=http://127.0.0.1:5282/src/weapons/test/bench.html
 */

import { chromium } from 'playwright';

const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const url = urlArg?.slice('--url='.length)
  ?? 'http://127.0.0.1:5282/src/weapons/test/bench.html';

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
  await page.waitForFunction(() => window.__BENCH_RESULT__ !== undefined, null, { timeout: 120_000 });
  result = await page.evaluate(() => window.__BENCH_RESULT__);
} finally {
  await browser.close();
}

const pass = result.pass && pageErrors.length === 0;
console.log(JSON.stringify({ url, pageErrors, ...result }, null, 2));
process.exit(pass ? 0 : 1);
