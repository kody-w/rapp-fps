/**
 * Playwright runner for the static-world integration fixtures (#37, parent #32).
 * Loads the browser harness through the dev server, reads its published result
 * and exits non-zero unless every test passes. Pass an explicit --url; harness
 * default ports have previously validated the wrong branch.
 *
 *   npm exec -- vite <repo> --host 127.0.0.1 --port 5282 --strictPort
 *   node src/weapons/test/run-staticworld.mjs --url=http://127.0.0.1:5282/src/weapons/test/staticworld.html
 */

import { chromium } from 'playwright';

const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const url = urlArg?.slice('--url='.length)
  ?? 'http://127.0.0.1:5282/src/weapons/test/staticworld.html';

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
  await page.waitForFunction(() => window.__STATICWORLD_RESULT__ !== undefined, null, { timeout: 60_000 });
  result = await page.evaluate(() => window.__STATICWORLD_RESULT__);
} finally {
  await browser.close();
}

const collectionOk = result.collectionErrors.length === 0 && pageErrors.length === 0;
const allPass = collectionOk && result.tests.every((test) => test.pass);

console.log(JSON.stringify({
  url,
  status: result.status,
  passed: allPass,
  pageErrors,
  collectionErrors: result.collectionErrors,
  tests: result.tests,
}, null, 2));

process.exit(allPass ? 0 : 1);
