/**
 * RELAY BLACKOUT traversal fixture runner (issue #72, parent #70).
 *
 * Loads `relay-traversal.harness.html` in headless Chromium via the dev server
 * so the drive is computed by the EXACT shipping modules (the mission's real
 * `StaticWorld` + the PR #40 `PlayerMotor`/`StaticBoxWorld`), prints the
 * assertion table + per-pad summaries, archives
 * `../evidence/relay-traversal.report.json`, and exits non-zero if either pad
 * fails to walk floor→deck→objective or the negative control unexpectedly
 * climbs.
 *
 * Usage (start the dev server first — see ../README.md):
 *   node src/level/missions/relay/fixtures/run-relay-traversal.mjs \
 *     --url http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-traversal.harness.html
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
  ?? 'http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-traversal.harness.html';
const OUT = fileURLToPath(new URL('../evidence/relay-traversal.report.json', import.meta.url));
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
  await page.waitForFunction(() => window.__RELAY_TRAVERSAL__ !== undefined
    || window.__RELAY_TRAVERSAL_ERROR__ !== undefined, null, { timeout: 45_000 });
  const err = await page.evaluate(() => window.__RELAY_TRAVERSAL_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the traversal harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__RELAY_TRAVERSAL__);
} catch {
  console.error('REFUSING: the traversal harness never published a result within 45s.');
  console.error('Is src/player present (PR #40) and the dev server serving this URL?');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

const t = report.derivedTargets;
console.log(`relay-traversal — shipping PlayerMotor vs mission StaticWorld (${report.world.boxes} boxes), `
  + `${report.fixedStepHz} Hz`);
console.log(`  deck top ${t.deckTop} m, interior z ≤ ${t.deckInteriorZ}; `
  + `throats W=${t.throatW} E=${t.throatE}; objective ${JSON.stringify(t.objective)}`);
for (const [name, r] of Object.entries(report.results)) {
  console.log(`  ${name}: spawn ${JSON.stringify(r.spawn)} → final `
    + `(${r.final.x}, ${r.final.y}, ${r.final.z}) grounded=${r.final.grounded}  `
    + `ticks=${r.ticks} reachedDeckTick=${r.reachedDeckTick} maxStepUp=${r.maxSteppedHeightM}m `
    + `airborne=${r.airborneClimbTicks}`);
}
console.log(`  negative-control (no steps): reachedDeck=${report.negativeControl.reachedDeck} `
  + `final=(${report.negativeControl.final.x}, ${report.negativeControl.final.y}, ${report.negativeControl.final.z})`);
for (const a of report.assertions) {
  console.log(`  [${a.passed ? 'PASS' : 'FAIL'}] ${a.name} → ${JSON.stringify(a.actual)}`);
}
console.log(`\nVERDICT: ${report.ok ? 'REACHABLE — both pads walk floor → deck → objective' : 'FAILED'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) {
  console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);
}

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
