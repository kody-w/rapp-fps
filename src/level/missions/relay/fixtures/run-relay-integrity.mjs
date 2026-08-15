/**
 * RELAY BLACKOUT integrity fixture runner (issue #72, parent #70).
 *
 * Loads `relay-integrity.harness.html` in headless Chromium (hardware WebGL2 via
 * ANGLE/Metal) so the five correspondence checks and the build/dispose/rebuild
 * lifecycle run against a REAL `THREE.WebGLRenderer` and the shipping
 * `ArenaLevel`. Prints the assertion table, archives
 * `../evidence/relay-integrity.report.json`, and exits non-zero on any failure.
 *
 * Usage (start the dev server first — see ../README.md):
 *   node src/level/missions/relay/fixtures/run-relay-integrity.mjs \
 *     --url http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-integrity.harness.html
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
  ?? 'http://127.0.0.1:5294/src/level/missions/relay/fixtures/relay-integrity.harness.html';
const OUT = fileURLToPath(new URL('../evidence/relay-integrity.report.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../evidence/', import.meta.url)), { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Wait for the harness result first (this tolerates the dev server's one-time
// dependency-optimization reload), THEN refuse a software rasteriser: the
// lifecycle GPU-handle release only means something on a real driver.
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

let report = null;
try {
  await page.waitForFunction(() => window.__RELAY_INTEGRITY__ !== undefined
    || window.__RELAY_INTEGRITY_ERROR__ !== undefined, null, { timeout: 45_000 });
} catch {
  console.error('REFUSING: the integrity harness never published a result within 45s.');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { ok: false, renderer: 'no webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { ok: true, renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown') };
});
if (!gpu.ok || /swiftshader|llvmpipe|software/i.test(gpu.renderer)) {
  console.error(`REFUSING: not a hardware renderer — "${gpu.renderer}".`);
  await browser.close();
  process.exit(2);
}

try {
  const err = await page.evaluate(() => window.__RELAY_INTEGRITY_ERROR__ ?? null);
  if (err) {
    console.error('REFUSING: the integrity harness threw before producing a result.');
    console.error(err);
    if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(3);
  }
  report = await page.evaluate(() => window.__RELAY_INTEGRITY__);
} catch {
  console.error('REFUSING: could not read the integrity result.');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

console.log(`relay-integrity — ${report.renderer}`);
console.log(`  correspondence: ${report.correspondenceChecks.map((c) => `${c.name}:${c.ok ? 'ok' : 'FAIL'}`).join('  ')}`);
console.log(`  merged buffers: ${report.mergedBuffers.meshes} meshes, ${report.mergedBuffers.vertices} verts, `
  + `${report.mergedBuffers.triangles} tris  [${report.mergedBuffers.materials.join(', ')}]`);
console.log(`  lifecycle geometries: build=${report.lifecycle.geomAfterBuild} → dispose=${report.lifecycle.geomAfterDispose}`);
for (const a of report.assertions) {
  console.log(`  [${a.passed ? 'PASS' : 'FAIL'}] ${a.name} → ${JSON.stringify(a.actual)}`);
}
console.log(`\nVERDICT: ${report.ok ? 'CORRESPONDENT & LIFECYCLE-CLEAN' : 'FAILED'}`);

writeFileSync(OUT, `${JSON.stringify({ url: TARGET_URL, consoleErrors, ...report }, null, 2)}\n`);
console.log(`report: ${OUT}`);

if (consoleErrors.length) console.error(`\nbrowser console errors:\n  ${consoleErrors.join('\n  ')}`);

await browser.close();
process.exit(report.ok && consoleErrors.length === 0 ? 0 : 1);
