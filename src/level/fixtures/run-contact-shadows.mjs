/**
 * Contact-shadow fixture runner (issue #60).
 *
 * Loads `contact-shadows.harness.html` through the dev server so the layer is
 * built and measured by the EXACT shipped modules on the real GPU path, reads
 * back `window.__CONTACT_SHADOWS_FIXTURE__`, prints the assertion table and the
 * selection / resource / pixel-diff summary, archives the full report to
 * `src/level/evidence/contact-shadows.report.json`, and exits non-zero if any
 * assertion failed or the page logged an error.
 *
 * Usage (start the dev server first — see src/level/README.md):
 *   node src/level/fixtures/run-contact-shadows.mjs \
 *     --url http://127.0.0.1:5287/src/level/fixtures/contact-shadows.harness.html
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
  ?? 'http://127.0.0.1:5287/src/level/fixtures/contact-shadows.harness.html';
const OUT = fileURLToPath(new URL('../evidence/contact-shadows.report.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../evidence/', import.meta.url)), { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

let report = null;
try {
  await page.waitForFunction(() => window.__CONTACT_SHADOWS_FIXTURE__ !== undefined
    || window.__CONTACT_SHADOWS_FIXTURE_ERROR__ !== undefined, null, { timeout: 45_000 });
  const err = await page.evaluate(() => window.__CONTACT_SHADOWS_FIXTURE_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the contact-shadow harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__CONTACT_SHADOWS_FIXTURE__);
} catch {
  console.error('REFUSING: the contact-shadow harness never published a result within 45s.');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

console.log(`contact-shadows — ${report.selection.count} marks under floor-standing cover`);
console.log(`  selected: ${report.selection.ids.join(', ')}`);
console.log(`  resource: +${report.resource.additionalDrawCalls} draw call, `
  + `+${report.resource.generatedTextures} generated texture(s)`);
const d = report.pixelDiff;
console.log(`  pixel diff (${d.viewport}): ${d.changedPixelsPct}% pixels changed, `
  + `mean ${d.meanDeltaChanged}/255 where changed (VSM baseline ${d.baselineVsm.changedPixelsPct}% / ${d.baselineVsm.meanDelta})`);
for (const a of report.assertions) {
  console.log(`  [${a.passed ? 'PASS' : 'FAIL'}] ${a.name}`);
  if (!a.passed) console.log(`        actual=${JSON.stringify(a.actual)}`);
}
console.log(`\nVERDICT: ${report.ok ? 'GROUNDED — authored contact layer verified' : 'FAILED'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) {
  console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);
}

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
