/**
 * Browser proof runner for the co-op gamepad input library.
 *
 * The Node runner (`run-isolation.mjs`) is the primary, dependency-light proof.
 * This one additionally shows the SAME `runIsolationSuite()` passing inside a
 * real browser: it starts the project's Vite dev server, loads the fixture
 * harness in headless Chromium, reads back `window.__COOP_INPUT_RESULT__`,
 * asserts every check passed with no console errors, archives
 * `evidence/report.browser.json`, and tears the server down.
 *
 *   node src/coop/input/fixtures/run-isolation-browser.mjs
 *
 * Requires the dev dependencies (`vite`, `playwright`) and a Chromium install
 * (`npx playwright install chromium`). If you only want a browser-free proof,
 * use `run-isolation.mjs` instead.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const evidenceDir = resolve(here, '../evidence');
const reportPath = resolve(evidenceDir, 'report.browser.json');

const HOST = '127.0.0.1';
const PORT = Number(process.env.COOP_INPUT_PORT ?? 5273);
const HARNESS = `http://${HOST}:${PORT}/src/coop/input/fixtures/harness.html`;

const vite = spawn(
  resolve(repoRoot, 'node_modules/.bin/vite'),
  ['--host', HOST, '--port', String(PORT), '--strictPort'],
  { cwd: repoRoot, stdio: 'ignore' },
);

let exitCode = 1;
try {
  await waitForServer(HARNESS, 30_000);

  const browser = await chromium.launch();
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(HARNESS, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__COOP_INPUT_READY__ === true, null, { timeout: 20_000 });
    const report = await page.evaluate(() => window.__COOP_INPUT_RESULT__);

    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ ...report, consoleErrors }, null, 2) + '\n');

    const clean = report.ok && consoleErrors.length === 0;
    process.stdout.write(
      `\nbrowser isolation proof — ${clean ? 'PASS' : 'FAIL'} `
        + `(${report.passed}/${report.total} checks, ${consoleErrors.length} console errors)\n`,
    );
    for (const f of report.failures) process.stdout.write(`  - ${f}\n`);
    for (const e of consoleErrors) process.stdout.write(`  console: ${e}\n`);
    process.stdout.write(`report written to ${reportPath}\n`);
    exitCode = clean ? 0 : 1;

    await page.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  process.stderr.write(`REFUSING: browser proof could not run: ${String(error)}\n`);
  exitCode = 12;
} finally {
  vite.kill('SIGTERM');
}

process.exit(exitCode);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
