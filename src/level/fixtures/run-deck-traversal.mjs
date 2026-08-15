/**
 * Deck-traversal fixture runner (issue #43, parent #32, level #35, motor #42).
 *
 * Loads `deck-traversal.harness.html` in a browser via the dev server so the
 * traversal is computed by the EXACT shipping modules (the arena's real
 * `StaticWorld` + the PR #40 `PlayerMotor`/`StaticBoxWorld`), not a side
 * transpile or a hand-copied port. Reads back `window.__DECK_TRAVERSAL__`,
 * prints the assertion table and trajectory summary, archives the full report
 * to `src/level/evidence/deck-traversal.report.json`, and exits non-zero if the
 * capsule did not start on the floor and finish standing on the deck.
 *
 * Dependency: the harness imports the player subsystem (`../../player/...`),
 * which lands with PR #40. Run in an integrated tree where `src/player/` exists.
 *
 * Usage (start the dev server first — see src/level/README.md):
 *   node src/level/fixtures/run-deck-traversal.mjs \
 *     --url http://127.0.0.1:5283/src/level/fixtures/deck-traversal.harness.html
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
  ?? 'http://127.0.0.1:5283/src/level/fixtures/deck-traversal.harness.html';
const OUT = fileURLToPath(new URL('../evidence/deck-traversal.report.json', import.meta.url));
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
  await page.waitForFunction(() => window.__DECK_TRAVERSAL__ !== undefined
    || window.__DECK_TRAVERSAL_ERROR__ !== undefined, null, { timeout: 45_000 });
  const err = await page.evaluate(() => window.__DECK_TRAVERSAL_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the traversal harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__DECK_TRAVERSAL__);
} catch {
  console.error('REFUSING: the traversal harness never published a result within 45s.');
  console.error('Is src/player present (PR #40) and the dev server serving this URL?');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

const t = report.derivedTargets;
console.log(`deck-traversal — shipping PlayerMotor vs arena StaticWorld (${report.world.boxes} boxes), `
  + `${report.fixedStepHz} Hz`);
console.log(`  spawn ${JSON.stringify(t.spawn)} (floor)  →  deck top ${t.deckTop} m, `
  + `interior z ≤ ${t.deckInteriorZ}`);
console.log(`  ticks=${report.metrics.ticks} reachedDeckTick=${report.metrics.reachedDeckTick} `
  + `maxStepUp=${report.metrics.maxSteppedHeightM} m airborneClimbTicks=${report.metrics.airborneClimbTicks}`);
console.log(`  final feet=(${report.metrics.final.x}, ${report.metrics.final.y}, ${report.metrics.final.z}) `
  + `grounded=${report.metrics.final.grounded}`);
for (const a of report.assertions) {
  console.log(`  [${a.passed ? 'PASS' : 'FAIL'}] ${a.name} → ${JSON.stringify(a.actual)}`);
}
console.log(`\nVERDICT: ${report.ok ? 'REACHABLE — a player walks floor → deck' : 'UNREACHABLE'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) {
  console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);
}

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
