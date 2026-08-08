import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  readFileSync,
} from 'node:fs';
import {
  access,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const playwrightVersion = require('playwright/package.json').version;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const generated = resolve(here, 'generated');
const candidate = resolve(here, '.generated-candidate');
const vite = resolve(root, 'node_modules/.bin/vite');
const port = 5361;
const baseUrl = `http://127.0.0.1:${port}/src/render/temporal/harness.html`;
const viewport = { width: 1920, height: 1080 };
const frameBudgetMs = 16.7;
const gpuSamplesPerTrial = 180;
const trialsPerMode = 3;
const args = parseArgs(process.argv.slice(2));
const modes = args.modes.split(',').map((mode) => mode.trim()).filter(Boolean);
const serverOutput = [];

validateModes(modes);
await requirePinnedChromium();
await rm(candidate, { recursive: true, force: true });

let browser;
let server;
let exitCode = 0;
try {
  server = startVite();
  await waitForVite(server);
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
    ],
  });

  const sourceCommit = git('rev-parse', 'HEAD');
  const baseCommit = git('rev-parse', '1c5acee');
  const aliases = createBlindAliases(modes, sourceCommit);
  const modeReports = {};
  let renderer = null;
  let controlImages = null;

  await mkdir(resolve(candidate, 'blind'), { recursive: true });
  for (let modeIndex = 0; modeIndex < modes.length; modeIndex++) {
    const mode = modes[modeIndex];
    const includeControls = mode === 'ultra' || (modeIndex === 0 && !modes.includes('ultra'));
    const capture = await captureMode(browser, mode, includeControls);
    renderer ??= capture.renderer;
    assert.equal(
      capture.renderer,
      renderer,
      `renderer changed between modes: ${renderer} versus ${capture.renderer}`,
    );
    const alias = aliases[mode];
    await writePng(
      resolve(candidate, 'blind', `${alias}-contact.png`),
      capture.images.contactSheet,
      1920,
      1080,
    );
    await writePng(
      resolve(candidate, 'blind', `${alias}-rois.png`),
      capture.images.roiSheet,
      1920,
      720,
    );
    if (capture.images.negativeControls || capture.images.ghostStrips) {
      controlImages = capture.images;
      if (capture.images.negativeControls) {
        await writePng(
          resolve(candidate, 'negative-controls.png'),
          capture.images.negativeControls,
          1920,
          640,
        );
      }
      if (capture.images.ghostStrips) {
        await writePng(
          resolve(candidate, 'ghost-strips.png'),
          capture.images.ghostStrips,
          1920,
          480,
        );
      }
    }
    delete capture.evidence.images;
    if (capture.evidence.controls) {
      assert.equal(
        capture.evidence.controls.allPass,
        true,
        `negative controls failed:\n${JSON.stringify(capture.evidence.controls, null, 2)}`,
      );
    }

    const performance = await runPerformanceTrials(browser, mode);
    for (const trial of performance.trials) {
      assert.deepEqual(
        trial.consoleErrors,
        [],
        `${mode} trial ${trial.trial} console errors:\n${trial.consoleErrors.join('\n')}`,
      );
    }
    modeReports[mode] = {
      anonymousId: alias,
      visual: capture.evidence,
      performance,
    };
  }

  assert.ok(renderer, 'renderer identification is missing');
  assert.doesNotMatch(
    renderer,
    /swiftshader|llvmpipe|software/i,
    `refusing software-rendered evidence: ${renderer}`,
  );
  assert.ok(controlImages, 'negative-control images were not generated');

  const comparisons = compareModes(modeReports);
  const decision = decideFromEvidence(comparisons);
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    issue: 'kody-w/rapp-fps#29',
    baseCommit,
    sourceCommit,
    harnessUrl: baseUrl,
    vitePort: port,
    viewport: `${viewport.width}x${viewport.height}`,
    renderer,
    browser: {
      engine: 'Playwright Chromium',
      version: browser.version(),
      playwrightVersion,
      source: 'playwright-bundled',
    },
    frameBudgetMs,
    gpuTrialsPerMode: trialsPerMode,
    gpuSamplesPerTrial,
    modes: modeReports,
    comparisons,
    decision,
    consoleErrors: Object.fromEntries(
      Object.entries(modeReports).map(([mode, value]) => [
        mode,
        value.performance.trials.flatMap((trial) => trial.consoleErrors),
      ]),
    ),
  };
  const blindReport = {
    schemaVersion: report.schemaVersion,
    capturedAt: report.capturedAt,
    issue: report.issue,
    viewport: report.viewport,
    renderer: report.renderer,
    frameBudgetMs,
    modes: Object.fromEntries(
      Object.values(modeReports)
        .sort((a, b) => a.anonymousId.localeCompare(b.anonymousId))
        .map((value) => [
          value.anonymousId,
          {
            contactSheet: `blind/${value.anonymousId}-contact.png`,
            roiSheet: `blind/${value.anonymousId}-rois.png`,
            summary: value.visual.summary,
            performance: value.performance.summary,
          },
        ]),
    ),
  };
  const blindKey = {
    warning: 'Keep this file from the blind critic until their comparison is complete.',
    mapping: aliases,
  };

  await writeJson(resolve(candidate, 'metrics.json'), report);
  await writeJson(resolve(candidate, 'blind-metrics.json'), blindReport);
  await writeJson(resolve(candidate, 'blind-key.json'), blindKey);
  await rm(generated, { recursive: true, force: true });
  await rename(candidate, generated);

  for (const [mode, value] of Object.entries(modeReports)) {
    process.stdout.write(
      `${mode}: motion p95 ${value.visual.summary.worstMotionCoverageNoiseP95.toFixed(3)}, `
        + `sharpness ${value.visual.summary.staticEdgeEnergy.toFixed(3)}, `
        + `GPU p95 worst ${value.performance.summary.gpuWorstP95Ms.toFixed(3)}ms, `
        + `paired p95 worst ${value.performance.summary.pairedWorstP95Ms.toFixed(3)}ms `
        + `(${value.performance.summary.budgetVerdict}).\n`,
    );
  }
  process.stdout.write(`Evidence written to ${generated}\n`);
} catch (error) {
  exitCode = 1;
  await rm(candidate, { recursive: true, force: true });
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const logs = serverOutput.join('').trim();
  process.stderr.write(`${message}${logs ? `\nVite output:\n${logs}` : ''}\n`);
} finally {
  if (browser) await browser.close();
  if (server) await stopServer(server);
}

process.exitCode = exitCode;

function parseArgs(argv) {
  const values = { modes: 'ultra' };
  for (const token of argv) {
    const match = /^--modes=(.+)$/.exec(token);
    if (!match) throw new Error(`Unsupported argument: ${token}`);
    values.modes = match[1];
  }
  return values;
}

function validateModes(values) {
  assert.ok(values.length > 0, 'at least one AA mode is required');
  assert.equal(
    new Set(values).size,
    values.length,
    'AA modes must not contain duplicates',
  );
  for (const mode of values) {
    assert.match(mode, /^[a-z0-9-]+$/, `unsafe AA mode: ${mode}`);
  }
}

async function requirePinnedChromium() {
  try {
    await access(chromium.executablePath(), fsConstants.X_OK);
  } catch {
    throw new Error(
      'Pinned Playwright Chromium is unavailable; run `npx playwright install chromium`.',
    );
  }
}

function startVite() {
  const child = spawn(vite, [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  child.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  return child;
}

async function waitForVite(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Vite on port ${port}.`);
}

async function captureMode(browserInstance, mode, includeControls) {
  const page = await browserInstance.newPage({
    viewport,
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(240_000);
  const consoleErrors = collectConsoleErrors(page);
  try {
    await page.goto(`${baseUrl}?run=capture&aa=${encodeURIComponent(mode)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => window.__TEMPORAL_EVIDENCE__?.status === 'ready',
    );
    const renderer = await hardwareRenderer(page);
    const evidence = await page.evaluate(
      (withControls) => window.__TEMPORAL_EVIDENCE__.capture(withControls),
      includeControls,
    );
    assert.deepEqual(
      consoleErrors,
      [],
      `${mode} capture console errors:\n${consoleErrors.join('\n')}`,
    );
    return {
      renderer,
      evidence,
      images: evidence.images,
    };
  } finally {
    await page.close();
  }
}

async function runPerformanceTrials(browserInstance, mode) {
  const trials = [];
  for (let trial = 1; trial <= trialsPerMode; trial++) {
    const page = await browserInstance.newPage({
      viewport,
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(120_000);
    const consoleErrors = collectConsoleErrors(page);
    try {
      await page.goto(
        `${baseUrl}?run=perf&sequence=fast-yaw&aa=${encodeURIComponent(mode)}&trial=${trial}`,
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
      );
      await page.waitForFunction(
        () => window.__TEMPORAL_EVIDENCE__?.status === 'ready',
      );
      const renderer = await hardwareRenderer(page);
      const supported = await page.evaluate(() => window.engine.profiler.gpuSupported);
      assert.equal(supported, true, `${mode} trial ${trial}: GPU timer unavailable`);
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.engine.profiler.reset());
      await page.waitForFunction(
        (samples) =>
          window.engine.profiler.snapshot().budgetFrameMs.samples >= samples,
        gpuSamplesPerTrial,
        { timeout: 90_000 },
      );
      const snapshot = await page.evaluate(() => window.engine.profiler.snapshot());
      assert.equal(
        snapshot.gpuDisjointCount,
        0,
        `${mode} trial ${trial}: GPU timing became disjoint`,
      );
      assert.ok(snapshot.gpuFrameMs.p95 !== null, 'GPU p95 is missing');
      assert.ok(snapshot.budgetFrameMs.p95 !== null, 'paired p95 is missing');
      trials.push({
        trial,
        renderer,
        gpuFrameMs: snapshot.gpuFrameMs,
        cpuFrameMs: snapshot.cpuFrameMs,
        pairedFrameMs: snapshot.budgetFrameMs,
        gpuDisjointCount: snapshot.gpuDisjointCount,
        consoleErrors: [...consoleErrors],
      });
    } finally {
      await page.close();
    }
  }
  const gpuMedians = trials.map((trial) => trial.gpuFrameMs.median);
  const gpuP95s = trials.map((trial) => trial.gpuFrameMs.p95);
  const pairedP95s = trials.map((trial) => trial.pairedFrameMs.p95);
  const pairedWorstP95Ms = Math.max(...pairedP95s);
  return {
    trials,
    summary: {
      gpuMedianOfMediansMs: median(gpuMedians),
      gpuWorstP95Ms: Math.max(...gpuP95s),
      pairedWorstP95Ms,
      p95HeadroomMs: rounded(frameBudgetMs - pairedWorstP95Ms),
      budgetVerdict: pairedWorstP95Ms <= frameBudgetMs ? 'PASS' : 'FAIL',
      requirement:
        `${trialsPerMode} hardware GPU trials at ${viewport.width}x${viewport.height}; `
        + `worst paired p95 <= ${frameBudgetMs}ms`,
    },
  };
}

async function hardwareRenderer(page) {
  const gpu = await page.evaluate(() => {
    const gl = window.engine.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return String(renderer);
  });
  assert.doesNotMatch(
    gpu,
    /swiftshader|llvmpipe|software/i,
    `refusing software-rendered evidence: ${gpu}`,
  );
  return gpu;
}

function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

function createBlindAliases(values, sourceCommit) {
  const shuffled = [...values].sort((a, b) => {
    const left = createHash('sha256')
      .update(`rapp-fps-29:${sourceCommit}:${a}`)
      .digest('hex');
    const right = createHash('sha256')
      .update(`rapp-fps-29:${sourceCommit}:${b}`)
      .digest('hex');
    return left.localeCompare(right);
  });
  return Object.fromEntries(
    shuffled.map((mode, index) => [mode, `mode-${String.fromCharCode(97 + index)}`]),
  );
}

function compareModes(modeReports) {
  const baseline = modeReports.ultra;
  if (!baseline) return [];
  return Object.entries(modeReports)
    .filter(([mode]) => mode !== 'ultra')
    .map(([mode, candidateReport]) => {
      const baselineMotion = baseline.visual.summary.worstMotionCoverageNoiseP95;
      const candidateMotion =
        candidateReport.visual.summary.worstMotionCoverageNoiseP95;
      const baselineSharpness = baseline.visual.summary.staticEdgeEnergy;
      const candidateSharpness = candidateReport.visual.summary.staticEdgeEnergy;
      const flickerImprovement = 1 - candidateMotion / baselineMotion;
      const sharpnessLoss = 1 - candidateSharpness / baselineSharpness;
      const maxGhost = Math.max(
        candidateReport.visual.summary.hardStopGhostTrailP95,
        candidateReport.visual.summary.revealGhostTrailP95,
      );
      const evidenceGate = {
        flickerImprovementAtLeast10Percent: flickerImprovement >= 0.1,
        sharpnessLossAtMost8Percent: sharpnessLoss <= 0.08,
        ghostTrailBelowOne: maxGhost <= 1,
        pairedP95WithinBudget:
          candidateReport.performance.summary.budgetVerdict === 'PASS',
      };
      return {
        baseline: 'ultra',
        candidate: mode,
        temporalFlickerImprovement: rounded(flickerImprovement),
        staticSharpnessLoss: rounded(sharpnessLoss),
        maximumGhostTrailP95: maxGhost,
        pairedP95DeltaMs: rounded(
          candidateReport.performance.summary.pairedWorstP95Ms
            - baseline.performance.summary.pairedWorstP95Ms,
        ),
        evidenceGate,
        allGatesPass: Object.values(evidenceGate).every(Boolean),
      };
    });
}

function decideFromEvidence(comparisons) {
  const passing = comparisons
    .filter((comparison) => comparison.allGatesPass)
    .sort(
      (left, right) =>
        right.temporalFlickerImprovement - left.temporalFlickerImprovement,
    );
  const selected = passing[0];
  return {
    verdict: selected ? 'CHANGE' : 'KEEP',
    selectedMode: selected?.candidate ?? 'ultra',
    issueClosingCriterionMet: Boolean(selected),
    reason: selected
      ? `${selected.candidate} is the strongest candidate that passes temporal, `
        + 'sharpness, ghost, and paired-p95 gates.'
      : 'No candidate passes every predeclared evidence gate.',
    taaStatus: 'BLOCKED',
    taaReason:
      'No motion-vector buffer or object-motion/disocclusion history-rejection contract exists.',
    naiveHistoryStatus: 'NEGATIVE_CONTROL_ONLY',
  };
}

async function writePng(path, dataUrl, expectedWidth, expectedHeight) {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  assert.equal(
    buffer.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
    `${path} is not a PNG`,
  );
  assert.equal(buffer.readUInt32BE(16), expectedWidth, `${path} width mismatch`);
  assert.equal(buffer.readUInt32BE(20), expectedHeight, `${path} height mismatch`);
  await writeFile(path, buffer);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(...gitArgs) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return rounded(sorted[Math.floor(sorted.length / 2)]);
}

function rounded(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  process.kill(child.pid, 'SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(2000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    process.kill(child.pid, 'SIGKILL');
    await exited;
  }
}
