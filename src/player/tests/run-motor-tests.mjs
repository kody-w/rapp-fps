/**
 * Player motor test runner.
 *
 * Loads the evidence harness in a real GPU-backed browser and executes the
 * deterministic numeric harness INSIDE that bundle (`__PLAYER_HARNESS_API__`),
 * so the committed report is produced by the exact modules that ship, not a
 * side transpile. Asserts every feel assertion passed and writes the full
 * report to `evidence/motor-report.json` for an independent reviewer to read.
 *
 * Run against the dev server on port 5281:
 *   node src/player/tests/run-motor-tests.mjs
 * or override the URL:
 *   PLAYER_URL=http://127.0.0.1:5281/src/player/harness.html \
 *     node src/player/tests/run-motor-tests.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE_URL = process.env.PLAYER_URL
  ?? 'http://127.0.0.1:5281/src/player/harness.html';
const EVIDENCE = fileURLToPath(new URL('../evidence/motor-report.json', import.meta.url));
mkdirSync(dirname(EVIDENCE), { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
  ],
});

const consoleErrors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
    timeout: 45_000,
  });

  const report = await page.evaluate(() => window.__PLAYER_HARNESS_API__.run());

  const failed = report.assertions.filter((a) => !a.passed);
  for (const assertion of report.assertions) {
    const label = `${assertion.name} → ${JSON.stringify(assertion.actual)} `
      + `[expected ${assertion.expected}]`;
    console.log(`${assertion.passed ? '  ok  ' : ' FAIL '} ${label}`);
  }

  writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);

  assert.equal(
    failed.length,
    0,
    `${failed.length} player feel assertion(s) failed:\n`
      + failed.map((a) => `  - ${a.name} (got ${JSON.stringify(a.actual)}, `
        + `expected ${a.expected})`).join('\n'),
  );
  assert.equal(report.passed, true, 'harness reported an overall failure');
  assert.deepEqual(consoleErrors, [], `browser console errors:\n${consoleErrors.join('\n')}`);

  console.log(`\nPASS — ${report.assertions.length}/${report.assertions.length} `
    + `player feel assertions. Report written to ${EVIDENCE}`);
  await page.close();
} finally {
  await browser.close();
}
