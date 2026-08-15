/**
 * Foundry lifecycle runner (Mission 3, issue #73).
 *
 * Loads `fixtures/lifecycle.html` through the dev server, reads back
 * `window.__FOUNDRY_LIFECYCLE__`, prints the per-cycle table, archives it to
 * `evidence/lifecycle.report.json`, and exits non-zero on failure or console
 * error.
 *
 * Usage (dev server on 5295):
 *   node src/level/missions/foundry/fixtures/run-lifecycle.mjs \
 *     --url http://127.0.0.1:5295/src/level/missions/foundry/fixtures/lifecycle.html
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith('--')) continue;
  const eq = /^--([^=]+)=(.*)$/.exec(t);
  if (eq) { args[eq[1]] = eq[2]; continue; }
  const key = t.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) { args[key] = '1'; } else { args[key] = next; i++; }
}

const TARGET_URL = args.url
  ?? 'http://127.0.0.1:5295/src/level/missions/foundry/fixtures/lifecycle.html';
const OUT = fileURLToPath(new URL('../evidence/lifecycle.report.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../evidence/', import.meta.url)), { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

let report = null;
try {
  await page.waitForFunction(() => window.__FOUNDRY_LIFECYCLE__ !== undefined
    || window.__FOUNDRY_LIFECYCLE_ERROR__ !== undefined, null, { timeout: 45_000 });
  const err = await page.evaluate(() => window.__FOUNDRY_LIFECYCLE_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the lifecycle harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__FOUNDRY_LIFECYCLE__);
} catch {
  console.error('REFUSING: the lifecycle harness never published a result within 45s.');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

console.log(`foundry lifecycle — baseline scene children=${report.baselineChildren}`);
report.cycles.forEach((c, i) => {
  console.log(`  cycle ${i + 1}: correspondence=${c.correspondenceOk} (boxes ${c.correspondenceBoxCount}/${c.correspondenceCollidable}) `
    + `added=${c.addedChildren} afterDispose=${c.childrenAfterDispose} baseline=${c.returnedToBaseline} hooks(installed=${c.hooksInstalled} cleared=${c.hooksCleared}) updateThrew=${c.updateThrew}`);
});
const u = report.undefinedDressingCycle;
if (u) {
  console.log(`  undefined-dressing cycle: initThrew=${u.initThrew}${u.initError ? ` ("${u.initError}")` : ''} `
    + `correspondence=${u.correspondenceOk} (boxes ${u.correspondenceBoxCount}/${u.correspondenceCollidable}) baseline=${u.returnedToBaseline}`);
}
for (const a of report.assertions) {
  console.log(`  [${a.passed ? 'PASS' : 'FAIL'}] ${a.name}`);
}
console.log(`\nVERDICT: ${report.ok ? 'CLEAN LIFECYCLE' : 'FAILED'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
