/**
 * RELAY BLACKOUT topology / LOS / clearance runner (issue #72, parent #70).
 *
 * Loads `relay-topology.harness.html` in headless Chromium via the dev server so
 * the analysis runs against the EXACT shipping modules (the factory, the shared
 * topology helpers, the shipping `StaticBoxWorld`), prints the assertion table
 * and the distinctness / LOS summaries, archives
 * `../evidence/relay-topology.report.json`, and exits non-zero if any assertion
 * failed (or the page logged an error).
 *
 * Usage (start the dev server first — see ../README.md):
 *   node src/level/missions/relay/fixtures/run-relay-topology.mjs \
 *     --url http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-topology.harness.html
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
  ?? 'http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-topology.harness.html';
const OUT = fileURLToPath(new URL('../evidence/relay-topology.report.json', import.meta.url));
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
  await page.waitForFunction(() => window.__RELAY_TOPOLOGY__ !== undefined
    || window.__RELAY_TOPOLOGY_ERROR__ !== undefined, null, { timeout: 45_000 });
  const err = await page.evaluate(() => window.__RELAY_TOPOLOGY_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the topology harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__RELAY_TOPOLOGY__);
} catch {
  console.error('REFUSING: the topology harness never published a result within 45s.');
  console.error('Is src/player present and the dev server serving this URL?');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

const c = report.comparison;
console.log(`relay-topology — RELAY BLACKOUT vs cargo bay`);
console.log(`  bounds  relay ${JSON.stringify(report.bounds.relay.size)}  cargo ${JSON.stringify(report.bounds.cargo.size)}`);
console.log(`  collidable ${report.budget.collidableCount}/${report.budget.ceiling}  sharedIds=${c.sharedIdCount}  `
  + `idSetDiffer=${c.idSetDiffer} routeDiffer=${c.routeDiffer} sightlineDiffer=${c.sightlineDiffer}`);
console.log(`  sightline blocked  relay=${report.fingerprints.relay.sightline.blockedTotal}/${report.fingerprints.relay.sightline.probeCount}  `
  + `cargo=${report.fingerprints.cargo.sightline.blockedTotal}/${report.fingerprints.cargo.sightline.probeCount}`);
console.log(`  LOS (${report.losPolicy.name}, eye ${report.losPolicy.eyeHeight} m): ${JSON.stringify(report.losMeasured)}`);
for (const s of report.spawns) {
  console.log(`  pad ${s.name} ${JSON.stringify(s.position)} fits=${s.fits} onFloor=${s.onFloor} inBounds=${s.inBounds} insideSolid=${s.insideSolid}`);
}
for (const a of report.assertions) {
  console.log(`  [${a.passed ? 'PASS' : 'FAIL'}] ${a.name} → ${JSON.stringify(a.actual)}`);
}
console.log(`\nVERDICT: ${report.ok ? 'DISTINCT, CLEAR & POLICY-CONFORMANT' : 'FAILED'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) {
  console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);
}

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
