/**
 * Committed, re-runnable proof that the arena's rendered geometry and its
 * collision agree — the check #8 lacked.
 *
 * It does NOT re-derive correspondence in this script (that would only prove the
 * script agrees with itself). It loads the real harness, lets the arena build
 * the real merged GPU buffers and the real `StaticWorld`, and reads back the
 * proof the runtime computed against those buffers in `window.__ARENA_CHECK__`.
 * If any check fails — an invisible collider, an offset box, a solid dropped
 * from one side — this exits non-zero and prints which.
 *
 * Usage (start the dev server first, see README):
 *   node src/level/verify-correspondence.mjs \
 *     --url http://127.0.0.1:5283/src/level/harness.html
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith('--')) continue;
  const eq = /^--([^=]+)=(.*)$/.exec(t);
  if (eq) { args[eq[1]] = eq[2]; continue; }
  const key = t.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) { args[key] = '1'; }
  else { args[key] = next; i++; }
}

const URL = args.url ?? 'http://127.0.0.1:5283/src/level/harness.html';
const OUT = args.out ?? 'shots/correspondence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

let report = null;
try {
  await page.waitForFunction(() => window.__ARENA_CHECK__ !== undefined, null, { timeout: 45_000 });
  report = await page.evaluate(() => window.__ARENA_CHECK__);
} catch {
  const bootError = await page.evaluate(() => window.__ARENA_BOOT_ERROR__ ?? null);
  console.error('REFUSING: the arena never published __ARENA_CHECK__ within 45s.');
  if (bootError) console.error('boot error:\n  ' + bootError);
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

const lines = report.results.map(
  (r) => `  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}`,
);
const summary = [
  `correspondence: ${report.ok ? 'OK' : 'FAILED'}`,
  `  solids=${report.solidCount} collidable=${report.collidableCount} `
    + `boxes=${report.boxCount} renderVertexKeys=${report.renderVertexKeys}`,
  ...lines,
].join('\n');
console.log(summary);

writeFileSync(
  join(OUT, 'report.json'),
  JSON.stringify({ at: new Date().toISOString(), url: URL, report, consoleErrors }, null, 2),
);

await browser.close();
process.exit(report.ok ? 0 : 1);
