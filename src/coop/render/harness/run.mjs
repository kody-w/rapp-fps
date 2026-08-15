/**
 * WebGL harness runner for the co-op split-screen render library. — Refs #71
 *
 * Starts a throwaway Vite dev server rooted at the repo (so bare `three` and the
 * library's `.js`-specifier-to-`.ts` imports resolve exactly as in the app),
 * opens the harness page in a real GPU-backed headless Chromium (ANGLE/Metal,
 * same flags as tools/verify-slice.mjs), waits for the on-page suite to finish,
 * asserts the correctness sections, records the measured (or honestly
 * UNVERIFIED) GPU trials, writes report.json, prints a summary, and exits
 * non-zero on any correctness failure or page/console error.
 *
 *   node src/coop/render/harness/run.mjs
 *
 * GPU timing never gates the exit code: an unmeasurable timer is reported as a
 * documented gap, not a pass or a failure — the same contract as the engine's
 * FrameProfiler. Correctness (slot isolation, exact seam) is deterministic and
 * IS gated.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const reportPath = resolve(here, 'report.json');
const HARNESS_PATH = 'src/coop/render/harness/harness.html';

const consoleErrors = [];
const pageErrors = [];
let server;
let browser;

function line(text) {
  process.stdout.write(text + '\n');
}

try {
  server = await createServer({
    configFile: false,
    root: repoRoot,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5399, strictPort: false },
    optimizeDeps: { include: ['three'] },
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0]
    ?? `http://127.0.0.1:${server.config.server.port}/`;
  const url = new URL(HARNESS_PATH, base).href;

  browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => Boolean(window.__COOP_HARNESS__ && window.__COOP_HARNESS__.done),
    { timeout: 120_000 },
  );
  const data = await page.evaluate(() => window.__COOP_HARNESS__);

  const report = {
    at: new Date().toISOString(),
    target: url,
    meta: data.meta,
    sections: data.sections,
    gpu: data.gpu,
    harnessErrors: data.errors,
    consoleErrors,
    pageErrors,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // ── Human summary ─────────────────────────────────────────────────────
  line('');
  line('co-op split-screen render — real-WebGL harness');
  line('='.repeat(72));
  line(`renderer: ${data.meta.unmaskedRenderer}`);
  line(`three r${data.meta.threeRevision}  webgl2=${data.meta.webgl2}  `
    + `timer=${data.meta.timerExt} (${data.meta.counterBits} bits)`);
  line('');
  for (const s of data.sections) {
    line(`  [${s.pass ? 'ok ' : 'BAD'}] ${s.name}`);
    if (!s.pass) line('        ' + JSON.stringify(s.detail));
  }
  line('');
  line(`GPU two-view trials @ half DPR (backing `
    + `${data.gpu.halfResBacking ? `${data.gpu.halfResBacking.width}x${data.gpu.halfResBacking.height}` : '?'}), `
    + `budget ${data.gpu.budgetMs}ms — ${data.gpu.verdict}`);
  if (data.gpu.reason) line(`  reason: ${data.gpu.reason}`);
  for (const [i, t] of data.gpu.trials.entries()) {
    line(`  trial ${i + 1}: samples=${t.samples} median=${fmt(t.medianMs)}ms `
      + `p95=${fmt(t.p95Ms)}ms disjoint=${t.disjoint} `
      + `underBudget=${t.underBudget === null ? 'n/a' : t.underBudget}`);
  }
  if (data.gpu.verdict === 'MEASURED') {
    line(`  all three trials p95 <= ${data.gpu.budgetMs}ms: ${data.gpu.allUnderBudget}`);
  }
  line('');

  const correctnessPass = data.sections.length > 0 && data.sections.every((s) => s.pass);
  const clean = consoleErrors.length === 0 && pageErrors.length === 0 && data.errors.length === 0;
  if (!correctnessPass || !clean) {
    line('='.repeat(72));
    if (!correctnessPass) line('RESULT: FAIL — a correctness section did not pass.');
    if (consoleErrors.length) line(`  console errors: ${consoleErrors.join(' | ')}`);
    if (pageErrors.length) line(`  page errors: ${pageErrors.join(' | ')}`);
    if (data.errors.length) line(`  harness errors: ${data.errors.join(' | ')}`);
    process.exitCode = 1;
  } else {
    line('='.repeat(72));
    line('RESULT: PASS — slot isolation and exact seam verified on real GPU. report.json written.');
    process.exitCode = 0;
  }
} catch (error) {
  line('HARNESS RUNNER ERROR: ' + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(3);
}
