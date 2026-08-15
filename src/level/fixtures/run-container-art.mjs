/**
 * Container-art fixture runner (issue #67).
 *
 * Loads `container-art.harness.html` through the dev server so the dressing layer
 * and material path are built and measured by the EXACT shipped modules on the
 * real GPU path, reads back `window.__CONTAINER_ART_FIXTURE__`, prints the
 * assertion table and the selection / resource / rib-normal summary, archives the
 * full report to `src/level/evidence/container-art.report.json`, and exits
 * non-zero if any assertion failed or the page logged an error.
 *
 * Usage (start the dev server first — see src/level/README.md):
 *   node src/level/fixtures/run-container-art.mjs \
 *     --url http://127.0.0.1:5287/src/level/fixtures/container-art.harness.html
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
  ?? 'http://127.0.0.1:5287/src/level/fixtures/container-art.harness.html';
const OUT = fileURLToPath(new URL('../evidence/container-art.report.json', import.meta.url));
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
  await page.waitForFunction(() => window.__CONTAINER_ART_FIXTURE__ !== undefined
    || window.__CONTAINER_ART_FIXTURE_ERROR__ !== undefined, null, { timeout: 45_000 });
  const err = await page.evaluate(() => window.__CONTAINER_ART_FIXTURE_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the container-art harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__CONTAINER_ART_FIXTURE__);
} catch {
  console.error('REFUSING: the container-art harness never published a result within 45s.');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

console.log(`container-art — ${report.selection.count} containers dressed`);
for (const a of report.selection.assemblies) {
  console.log(`  ${a.id}: long-${a.longAxis}, door@${a.doorEnd}, ${a.partCount} parts `
    + `(${Object.entries(a.parts).map(([k, n]) => `${n} ${k}`).join(', ')})`);
}
console.log(`  geometry: ${report.geometry.triangleCount} tris (ceiling ${report.budget.maxTriangles})`);
console.log(`  resource: +${report.resource.additionalDrawCalls} draws, `
  + `+${report.resource.additionalTextures} texture(s)`);
console.log(`  rib normal: ${report.ribNormal.scanlineSignChanges} scanline sign-changes `
  + `(~${report.ribNormal.expectedPeriods} periods expected), swing ${report.ribNormal.scanlineSwing}/255`);
for (const a of report.assertions) {
  console.log(`  [${a.passed ? 'PASS' : 'FAIL'}] ${a.name}`);
  if (!a.passed) console.log(`        actual=${JSON.stringify(a.actual)}`);
}
console.log(`\nVERDICT: ${report.ok ? 'DRESSED — procedural container art verified' : 'FAILED'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) {
  console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);
}

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
