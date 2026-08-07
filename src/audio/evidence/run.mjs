import { spawn } from 'node:child_process';
import {
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const generated = resolve(here, 'generated');
const vite = resolve(root, 'node_modules/.bin/vite');
const url = 'http://127.0.0.1:5333/src/audio/evidence/index.html';
const serverOutput = [];

const server = spawn(vite, [
  '--host', '127.0.0.1',
  '--port', '5333',
  '--strictPort',
], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));

let browser;
let exitCode = 0;
try {
  await waitForVite(server);
  browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('#run');
  await page.waitForFunction(
    () => ['complete', 'failed'].includes(window.__AUDIO_EVIDENCE__?.status),
    undefined,
    { timeout: 180_000 },
  );
  const evidence = await page.evaluate(() => window.__AUDIO_EVIDENCE__);
  if (evidence.status === 'failed') throw new Error(evidence.error);
  if (evidence.status !== 'complete') throw new Error('Evidence did not complete.');

  await rm(generated, { recursive: true, force: true });
  await mkdir(generated, { recursive: true });
  for (const [name, base64] of Object.entries(evidence.wavs)) {
    if (!/^[a-z0-9-]+\.wav$/.test(name)) {
      throw new Error(`Unsafe evidence filename: ${name}`);
    }
    await writeFile(resolve(generated, name), Buffer.from(base64, 'base64'));
  }

  const report = {
    ...evidence.report,
    browser: {
      engine: 'Chromium',
      version: browser.version(),
    },
    consoleErrors,
  };
  await writeFile(
    resolve(generated, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (consoleErrors.length > 0) {
    throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`);
  }

  process.stdout.write(
    `Generated ${Object.keys(evidence.wavs).length} WAV renders and report.json.\n`,
  );
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const logs = serverOutput.join('').trim();
  process.stderr.write(`${message}${logs ? `\nVite output:\n${logs}` : ''}\n`);
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}

process.exitCode = exitCode;

async function waitForVite(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Timed out waiting for Vite on port 5333.');
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  process.kill(child.pid, 'SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 2000)),
  ]);
  if (!stopped && child.exitCode === null) {
    process.kill(child.pid, 'SIGKILL');
    await exited;
  }
}
