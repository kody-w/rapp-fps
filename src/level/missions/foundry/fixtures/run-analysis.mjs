/**
 * Foundry analysis runner (Mission 3, issue #73).
 *
 * Loads `fixtures/analysis.html` through the dev server so every gate is
 * computed by the EXACT shipping modules (arena `StaticWorld` + shipping
 * `PlayerMotor`/`StaticBoxWorld`, and the mission's own pure fingerprint/LOS),
 * reads back `window.__FOUNDRY_ANALYSIS__`, prints the assertion table, archives
 * the full report to `evidence/analysis.report.json`, and exits non-zero on any
 * failure or console error.
 *
 * Usage (start the dev server on 5295 first — see fixtures/README.md):
 *   node src/level/missions/foundry/fixtures/run-analysis.mjs \
 *     --url http://127.0.0.1:5295/src/level/missions/foundry/fixtures/analysis.html
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
  ?? 'http://127.0.0.1:5295/src/level/missions/foundry/fixtures/analysis.html';
const OUT = fileURLToPath(new URL('../evidence/analysis.report.json', import.meta.url));
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
  await page.waitForFunction(() => window.__FOUNDRY_ANALYSIS__ !== undefined
    || window.__FOUNDRY_ANALYSIS_ERROR__ !== undefined, null, { timeout: 45_000 });
  const err = await page.evaluate(() => window.__FOUNDRY_ANALYSIS_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the analysis harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__FOUNDRY_ANALYSIS__);
} catch {
  console.error('REFUSING: the analysis harness never published a result within 45s.');
  console.error('Is src/player present and the dev server serving this URL on port 5295?');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

const w = report.world;
const r = report.route.positive;
const n = report.route.negativeControl;
console.log(`foundry analysis — "${report.mission}" — ${report.route.fixedStepHz} Hz shipping motor`);
console.log(`  world: ${w.collidableBoxes} collidable boxes (<= ${w.ceiling}: ${w.withinCeiling}), valid=${w.valid}`);
console.log(`  spawns: ${report.spawns.slots.length} slots, minSep=${report.spawns.minSeparationM} m, allClear=${report.spawns.allClear}`);
console.log(`  enemy spawn: (${report.enemySpawn.spawn.join(',')}) clear=${report.enemySpawn.clear} (fits=${report.enemySpawn.fits} inBounds=${report.enemySpawn.insideBounds} feetOnFloor=${report.enemySpawn.feetOnFloor})`);
console.log(`  los: objective occluded from all spawns = ${report.los.objectiveOccludedFromAllSpawns}`);
console.log(`  stair: rises=${JSON.stringify(report.stair.rises)} maxRise=${report.stair.maxDesignedRiseM} m topFlush=${report.stair.topTreadFlushWithGantry}`);
console.log(`  route(+): ticks=${r.ticks} reachedObjective=${r.reachedObjective} maxStepUp=${r.maxSteppedHeightM} m airborneClimb=${r.airborneClimbTicks} final=(${r.final.x},${r.final.y},${r.final.z})`);
console.log(`  objective acceptance: footprint=[${r.objectiveFootprint.join(',')}] arrivalRadius=${r.arrivalRadiusM} m (half-footprint=${r.arrivalRadiusHalfFootprintM} m) hToObj=${r.hToObjectiveM} m footprintControls=${r.footprintControlsAcceptance}`);
console.log(`  route(−): sabotage=${n.sabotage} reachedGantry=${n.reachedGantry} reachedObjective=${n.reachedObjective} (must be false)`);
console.log(`  fingerprint vs cargo: allDistinct=${report.fingerprint.allDistinct}`);
for (const f of report.fingerprint.fields) {
  console.log(`     [${f.distinct ? 'DIFF' : 'SAME'}] ${f.name}: foundry=${f.a} cargo=${f.b}`);
}
console.log('  assertions:');
for (const a of report.assertions) {
  console.log(`   [${a.passed ? 'PASS' : 'FAIL'}] ${a.name}`);
}
console.log(`\nVERDICT: ${report.ok ? 'ALL GATES PASS' : 'FAILED'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) {
  console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);
}

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
