import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
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
const frameBudgetMs = 16.7;
const gpuSamplesPerTrial = 180;
const trialsPerMode = 3;
const supportedModes = new Set(['ultra', 'msaa2', 'msaa4']);
const profileDefinitions = {
  dpr1: {
    label: '1920x1080 CSS / DPR 1',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    dpr: '1',
  },
  retina2: {
    label: '1512x982 CSS / DPR 2 uncapped',
    viewport: { width: 1512, height: 982 },
    deviceScaleFactor: 2,
    dpr: '2',
  },
  'retina-auto': {
    label: '1512x982 CSS / production auto DPR',
    viewport: { width: 1512, height: 982 },
    deviceScaleFactor: 2,
    dpr: 'auto',
  },
};
const args = parseArgs(process.argv.slice(2));
const modes = splitList(args.modes);
const profileNames = splitList(args.profiles);
const serverOutput = [];

validateSelections(modes, profileNames);
requireCleanTrackedTree();
if (args.preflightOnly) {
  process.stdout.write('Evidence preflight passed: tracked tree is clean and controls are valid.\n');
  process.exit(0);
}

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
  const matrix = {};
  const visualImages = new Map();
  let renderer = null;
  let controlImages = null;

  for (const profileName of profileNames) {
    const profile = profileDefinitions[profileName];
    const modeReports = {};
    for (const mode of modes) {
      const includeControls = profileName === 'dpr1' && mode === 'ultra';
      const capture = await captureMode(
        browser,
        profileName,
        profile,
        mode,
        includeControls,
      );
      renderer ??= capture.renderer;
      assert.equal(
        capture.renderer,
        renderer,
        `renderer changed between captures: ${renderer} versus ${capture.renderer}`,
      );
      visualImages.set(`${profileName}/${mode}`, capture.images);
      if (capture.images.negativeControls || capture.images.ghostStrips) {
        controlImages = capture.images;
      }
      delete capture.evidence.images;
      if (capture.evidence.controls) {
        assert.equal(
          capture.evidence.controls.allPass,
          true,
          `negative controls failed:\n${JSON.stringify(capture.evidence.controls, null, 2)}`,
        );
      }

      const performance = await runPerformanceTrials(
        browser,
        profileName,
        profile,
        mode,
      );
      modeReports[mode] = {
        diagnostics: capture.diagnostics,
        visual: compactVisualEvidence(capture.evidence),
        performance,
      };
    }
    matrix[profileName] = {
      definition: profile,
      modes: modeReports,
    };
  }

  assert.ok(renderer, 'renderer identification is missing');
  assert.ok(controlImages, 'negative-control images were not generated');

  const fallbackTo2 = await captureMode(
    browser,
    'forced-fallback-2x',
    profileDefinitions.dpr1,
    'msaa4',
    false,
    '2',
  );
  assert.equal(fallbackTo2.diagnostics.effectiveAa, 'msaa2');
  assert.equal(fallbackTo2.diagnostics.composerMultisampling, 2);
  visualImages.set('forced-fallback-2x/msaa4', fallbackTo2.images);
  delete fallbackTo2.evidence.images;

  const fallbackToSmaa = await probeFallback(
    browser,
    profileDefinitions.dpr1,
    '0',
  );
  assert.equal(fallbackToSmaa.diagnostics.effectiveAa, 'ultra');
  assert.equal(fallbackToSmaa.diagnostics.composerMultisampling, 0);
  const invalidAa = await verifyInvalidAaRefused(browser);

  const retinaComparisons = compareModes(matrix['retina-auto'].modes);
  const capTradeoff = compareProfiles(
    matrix.retina2.modes.ultra,
    matrix['retina-auto'].modes.ultra,
  );
  const decision = decideFromEvidence(
    retinaComparisons,
    matrix.retina2.modes,
    matrix['retina-auto'].modes,
  );
  assert.equal(
    decision.selectedMode,
    'ultra',
    'Measured evidence selected a different shipping AA mode; update RenderSystem and rerun.',
  );

  const blindSets = createBlindSets(sourceCommit, matrix);
  await mkdir(resolve(candidate, 'blind'), { recursive: true });
  const blindMetrics = {};
  const blindKey = {
    warning: 'Keep this file from the blind critic until comparison is complete.',
    sets: {},
  };
  for (const set of blindSets) {
    blindMetrics[set.name] = {
      question: set.question,
      modes: {},
    };
    blindKey.sets[set.name] = {};
    for (const entry of set.entries) {
      const images = visualImages.get(entry.imageKey);
      assert.ok(images, `missing visual images for ${entry.imageKey}`);
      await writePng(
        resolve(candidate, 'blind', `${set.name}-${entry.alias}-contact.png`),
        images.contactSheet,
        1024,
        864,
      );
      await writePng(
        resolve(candidate, 'blind', `${set.name}-${entry.alias}-rois.png`),
        images.roiSheet,
        1024,
        576,
      );
      blindMetrics[set.name].modes[entry.alias] = {
        contactSheet: `blind/${set.name}-${entry.alias}-contact.png`,
        roiSheet: `blind/${set.name}-${entry.alias}-rois.png`,
        summary: entry.summary(),
      };
      blindKey.sets[set.name][entry.alias] = entry.label;
    }
  }

  if (controlImages.negativeControls) {
    await writePng(
      resolve(candidate, 'negative-controls.png'),
      controlImages.negativeControls,
      1024,
      576,
    );
  }
  if (controlImages.ghostStrips) {
    await writePng(
      resolve(candidate, 'ghost-strips.png'),
      controlImages.ghostStrips,
      1024,
      384,
    );
  }

  const capabilityControls = {
    actual: matrix.dpr1.modes.msaa4.diagnostics.rgba16fSupportedSamples,
    forcedTwoSampleCeiling: {
      requestedAa: fallbackTo2.diagnostics.requestedAa,
      effectiveAa: fallbackTo2.diagnostics.effectiveAa,
      composerMultisampling: fallbackTo2.diagnostics.composerMultisampling,
      capability: fallbackTo2.diagnostics.rgba16fEffectiveSamples,
      fallbackReason: fallbackTo2.diagnostics.aaFallbackReason,
      passes:
        fallbackTo2.diagnostics.effectiveAa === 'msaa2'
        && fallbackTo2.diagnostics.composerMultisampling === 2,
    },
    forcedNoSamples: {
      requestedAa: fallbackToSmaa.diagnostics.requestedAa,
      effectiveAa: fallbackToSmaa.diagnostics.effectiveAa,
      composerMultisampling: fallbackToSmaa.diagnostics.composerMultisampling,
      capability: fallbackToSmaa.diagnostics.rgba16fEffectiveSamples,
      fallbackReason: fallbackToSmaa.diagnostics.aaFallbackReason,
      passes:
        fallbackToSmaa.diagnostics.effectiveAa === 'ultra'
        && fallbackToSmaa.diagnostics.composerMultisampling === 0,
    },
  };
  assert.equal(capabilityControls.forcedTwoSampleCeiling.passes, true);
  assert.equal(capabilityControls.forcedNoSamples.passes, true);

  const report = {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    issue: 'kody-w/rapp-fps#29',
    baseCommit,
    sourceCommit,
    sourceIntegrity: {
      trackedTreeCleanAtStart: true,
      policy: 'runner refuses staged or unstaged tracked changes before Vite starts',
    },
    harnessUrl: baseUrl,
    vitePort: port,
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
    matrix,
    retinaComparisons,
    dprCapTradeoff: capTradeoff,
    capabilityControls,
    invalidAaControl: invalidAa,
    decision,
    committedEvidence: {
      rawPerFrameData: 'omitted; committed metrics contain distributions and summaries only',
      blindSets: blindSets.map((set) => set.name),
      representativeFramesPerSequence: 4,
    },
  };

  await writeJson(resolve(candidate, 'metrics.json'), report);
  await writeJson(
    resolve(candidate, 'blind-metrics.json'),
    {
      schemaVersion: report.schemaVersion,
      capturedAt: report.capturedAt,
      issue: report.issue,
      renderer: report.renderer,
      frameBudgetMs,
      sets: blindMetrics,
    },
  );
  await writeJson(resolve(candidate, 'blind-key.json'), blindKey);
  await rm(generated, { recursive: true, force: true });
  await rename(candidate, generated);

  for (const profileName of profileNames) {
    for (const mode of modes) {
      const value = matrix[profileName].modes[mode];
      process.stdout.write(
        `${profileName}/${mode} -> ${value.diagnostics.effectiveAa}, `
          + `${value.diagnostics.drawingBufferWidth}x`
          + `${value.diagnostics.drawingBufferHeight}: motion p95 `
          + `${value.visual.summary.worstMotionCoverageNoiseP95.toFixed(3)}, `
          + `sharpness ${value.visual.summary.staticEdgeEnergy.toFixed(3)}, `
          + `paired p95 ${value.performance.summary.pairedWorstP95Ms.toFixed(3)}ms `
          + `(${value.performance.summary.budgetVerdict}).\n`,
      );
    }
  }
  process.stdout.write(
    `Decision: ${decision.verdict}; shipping ${decision.selectedMode} at `
      + `${decision.selectedDprMode} DPR policy.\n`,
  );
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
  const values = {
    modes: 'ultra,msaa2,msaa4',
    profiles: 'dpr1,retina2,retina-auto',
    preflightOnly: false,
  };
  for (const token of argv) {
    if (token === '--preflight-only') {
      values.preflightOnly = true;
      continue;
    }
    const match = /^--(modes|profiles)=(.+)$/.exec(token);
    if (!match) throw new Error(`Unsupported argument: ${token}`);
    values[match[1]] = match[2];
  }
  return values;
}

function splitList(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function validateSelections(selectedModes, selectedProfiles) {
  assert.ok(selectedModes.length > 0, 'at least one AA mode is required');
  assert.ok(selectedProfiles.length > 0, 'at least one profile is required');
  assert.equal(new Set(selectedModes).size, selectedModes.length, 'AA modes must be unique');
  assert.equal(
    new Set(selectedProfiles).size,
    selectedProfiles.length,
    'profiles must be unique',
  );
  for (const mode of selectedModes) {
    if (!supportedModes.has(mode)) {
      throw new Error(
        `Unsupported evidence AA mode "${mode}". Expected: `
          + `${[...supportedModes].join(', ')}.`,
      );
    }
  }
  for (const profile of selectedProfiles) {
    if (!Object.hasOwn(profileDefinitions, profile)) {
      throw new Error(
        `Unsupported evidence profile "${profile}". Expected: `
          + `${Object.keys(profileDefinitions).join(', ')}.`,
      );
    }
  }
}

function requireCleanTrackedTree() {
  const status = git('status', '--porcelain=v1', '--untracked-files=no');
  if (status !== '') {
    throw new Error(
      'REFUSING: tracked files are staged or modified. Commit or restore them '
        + `before capture:\n${status}`,
    );
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

async function captureMode(
  browserInstance,
  profileName,
  profile,
  mode,
  includeControls,
  forcedSamples = null,
) {
  const page = await browserInstance.newPage({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
  });
  page.setDefaultTimeout(300_000);
  const consoleErrors = collectConsoleErrors(page);
  try {
    await page.goto(
      harnessUrl({
        run: 'capture',
        aa: mode,
        dpr: profile.dpr,
        ...(forcedSamples === null
          ? {}
          : { forceRgba16fSamples: forcedSamples }),
      }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await page.waitForFunction(
      () => window.__TEMPORAL_EVIDENCE__?.status === 'ready',
    );
    const renderer = await hardwareRenderer(page);
    const diagnostics = await page.evaluate(() => window.__RENDER_DIAGNOSTICS__);
    validateDiagnostics(profileName, profile, mode, diagnostics);
    const evidence = await page.evaluate(
      (withControls) => window.__TEMPORAL_EVIDENCE__.capture(withControls),
      includeControls,
    );
    assert.equal(
      evidence.methodology.viewport,
      `${diagnostics.drawingBufferWidth}x${diagnostics.drawingBufferHeight}`,
    );
    assert.deepEqual(
      consoleErrors,
      [],
      `${profileName}/${mode} capture console errors:\n${consoleErrors.join('\n')}`,
    );
    return {
      renderer,
      diagnostics,
      evidence,
      images: evidence.images,
    };
  } finally {
    await page.close();
  }
}

async function runPerformanceTrials(
  browserInstance,
  profileName,
  profile,
  mode,
) {
  const trials = [];
  for (let trial = 1; trial <= trialsPerMode; trial++) {
    const page = await browserInstance.newPage({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
    });
    page.setDefaultTimeout(150_000);
    const consoleErrors = collectConsoleErrors(page);
    try {
      await page.goto(
        harnessUrl({
          run: 'perf',
          sequence: 'fast-yaw',
          aa: mode,
          dpr: profile.dpr,
          trial: String(trial),
        }),
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
      );
      await page.waitForFunction(
        () => window.__TEMPORAL_EVIDENCE__?.status === 'ready',
      );
      const renderer = await hardwareRenderer(page);
      const diagnostics = await page.evaluate(() => window.__RENDER_DIAGNOSTICS__);
      validateDiagnostics(profileName, profile, mode, diagnostics);
      const supported = await page.evaluate(() => window.engine.profiler.gpuSupported);
      assert.equal(
        supported,
        true,
        `${profileName}/${mode} trial ${trial}: GPU timer unavailable`,
      );
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.engine.profiler.reset());
      await page.waitForFunction(
        (samples) =>
          window.engine.profiler.snapshot().budgetFrameMs.samples >= samples,
        gpuSamplesPerTrial,
        { timeout: 120_000 },
      );
      const snapshot = await page.evaluate(() => window.engine.profiler.snapshot());
      assert.equal(
        snapshot.gpuDisjointCount,
        0,
        `${profileName}/${mode} trial ${trial}: GPU timing became disjoint`,
      );
      assert.ok(snapshot.gpuFrameMs.p95 !== null, 'GPU p95 is missing');
      assert.ok(snapshot.budgetFrameMs.p95 !== null, 'paired p95 is missing');
      assert.deepEqual(
        consoleErrors,
        [],
        `${profileName}/${mode} trial ${trial} console errors:\n`
          + consoleErrors.join('\n'),
      );
      trials.push({
        trial,
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
      pairedMedianP95Ms: median(pairedP95s),
      pairedWorstP95Ms,
      p95HeadroomMs: rounded(frameBudgetMs - pairedWorstP95Ms),
      budgetVerdict: pairedWorstP95Ms <= frameBudgetMs ? 'PASS' : 'FAIL',
      requirement:
        `${trialsPerMode} hardware GPU trials; worst paired p95 <= `
        + `${frameBudgetMs}ms`,
    },
  };
}

async function probeFallback(browserInstance, profile, forcedSamples) {
  const page = await browserInstance.newPage({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
  });
  const consoleErrors = collectConsoleErrors(page);
  try {
    await page.goto(
      harnessUrl({
        run: 'capture',
        aa: 'msaa4',
        dpr: profile.dpr,
        forceRgba16fSamples: forcedSamples,
      }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await page.waitForFunction(
      () => window.__TEMPORAL_EVIDENCE__?.status === 'ready',
    );
    const diagnostics = await page.evaluate(() => window.__RENDER_DIAGNOSTICS__);
    validateDiagnostics('forced-fallback', profile, 'msaa4', diagnostics);
    assert.deepEqual(consoleErrors, []);
    return { diagnostics };
  } finally {
    await page.close();
  }
}

async function verifyInvalidAaRefused(browserInstance) {
  const page = await browserInstance.newPage({
    viewport: profileDefinitions.dpr1.viewport,
    deviceScaleFactor: 1,
  });
  const errors = collectConsoleErrors(page);
  try {
    await page.goto(
      harnessUrl({ run: 'capture', aa: 'not-a-mode', dpr: '1' }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await page.waitForTimeout(500);
    const apiExists = await page.evaluate(
      () => typeof window.__TEMPORAL_EVIDENCE__ !== 'undefined',
    );
    const refused = errors.some((error) => error.includes('Unsupported aa mode'));
    assert.equal(refused, true, 'aa=not-a-mode was not refused');
    assert.equal(apiExists, true, 'harness API should expose failed startup state');
    return {
      requested: 'not-a-mode',
      refused,
      exitSemantics: 'runner allowlist rejects before capture; URL startup throws',
      expectedErrors: errors,
      passes: refused,
    };
  } finally {
    await page.close();
  }
}

function validateDiagnostics(profileName, profile, requestedMode, diagnostics) {
  assert.equal(diagnostics.requestedAa, requestedMode);
  assert.equal(diagnostics.requestedDpr, profile.dpr);
  const expectedAa = expectedEffectiveAa(
    requestedMode,
    diagnostics.rgba16fEffectiveSamples,
  );
  assert.equal(
    diagnostics.effectiveAa,
    expectedAa,
    `${profileName}/${requestedMode}: effective AA mismatch`,
  );
  if (expectedAa === requestedMode) {
    assert.equal(diagnostics.aaFallbackReason, null);
  } else {
    assert.ok(
      diagnostics.aaFallbackReason,
      `${profileName}/${requestedMode}: fallback reason is missing`,
    );
  }
  assert.equal(
    diagnostics.composerMultisampling,
    samplesForMode(expectedAa),
  );
  assert.equal(diagnostics.cssWidth, profile.viewport.width);
  assert.equal(diagnostics.cssHeight, profile.viewport.height);
  assert.ok(diagnostics.drawingBufferWidth > 0);
  assert.ok(diagnostics.drawingBufferHeight > 0);
  assert.equal(
    diagnostics.drawingBufferPixels,
    diagnostics.drawingBufferWidth * diagnostics.drawingBufferHeight,
  );
  if (profile.dpr !== 'auto') {
    assert.equal(diagnostics.effectiveDpr, Number(profile.dpr));
  } else {
    assert.ok(diagnostics.effectiveDpr <= 1.5);
    assert.ok(diagnostics.drawingBufferPixels <= 3_350_000);
  }
}

function expectedEffectiveAa(requested, samples) {
  if (requested === 'msaa4') {
    if (samples.includes(4)) return 'msaa4';
    if (samples.includes(2)) return 'msaa2';
    return 'ultra';
  }
  if (requested === 'msaa2') return samples.includes(2) ? 'msaa2' : 'ultra';
  return requested;
}

function samplesForMode(mode) {
  if (mode === 'msaa4') return 4;
  if (mode === 'msaa2') return 2;
  return 0;
}

function compactVisualEvidence(evidence) {
  return {
    methodology: evidence.methodology,
    summary: evidence.summary,
    sequences: Object.fromEntries(
      Object.entries(evidence.sequences).map(([name, sequence]) => [
        name,
        {
          coverageNoiseP95: {
            all: sequence.analysis.all.coverageNoise.p95,
            bars: sequence.analysis.bars.coverageNoise.p95,
            specular: sequence.analysis.specular.coverageNoise.p95,
          },
          compensatedFrameDifferenceP95: {
            all: sequence.analysis.all.compensatedFrameDifference.p95,
            bars: sequence.analysis.bars.compensatedFrameDifference.p95,
            specular: sequence.analysis.specular.compensatedFrameDifference.p95,
          },
          edgeEnergyMedian: {
            all: sequence.analysis.all.edgeEnergy.median,
            bars: sequence.analysis.bars.edgeEnergy.median,
            specular: sequence.analysis.specular.edgeEnergy.median,
          },
          ghostTrailP95: sequence.ghostTrail?.trail.p95 ?? null,
        },
      ]),
    ),
    ...(evidence.controls ? { controls: evidence.controls } : {}),
  };
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
        pairedMedianP95DeltaMs: rounded(
          candidateReport.performance.summary.pairedMedianP95Ms
            - baseline.performance.summary.pairedMedianP95Ms,
        ),
        evidenceGate,
        allGatesPass: Object.values(evidenceGate).every(Boolean),
      };
    });
}

function compareProfiles(uncapped, capped) {
  const uncappedSharpness = uncapped.visual.summary.staticEdgeEnergy;
  const cappedSharpness = capped.visual.summary.staticEdgeEnergy;
  const uncappedMotion = uncapped.visual.summary.worstMotionCoverageNoiseP95;
  const cappedMotion = capped.visual.summary.worstMotionCoverageNoiseP95;
  return {
    comparison: 'retina2/ultra versus retina-auto/ultra',
    drawingBufferPixels: {
      uncapped: uncapped.diagnostics.drawingBufferPixels,
      capped: capped.diagnostics.drawingBufferPixels,
      reduction: rounded(
        1 - capped.diagnostics.drawingBufferPixels
          / uncapped.diagnostics.drawingBufferPixels,
      ),
    },
    staticSharpness: {
      uncapped: uncappedSharpness,
      capped: cappedSharpness,
      loss: rounded(1 - cappedSharpness / uncappedSharpness),
    },
    temporalNoise: {
      uncapped: uncappedMotion,
      capped: cappedMotion,
      change: rounded(cappedMotion / uncappedMotion - 1),
    },
    pairedP95Ms: {
      uncapped: uncapped.performance.summary.pairedWorstP95Ms,
      capped: capped.performance.summary.pairedWorstP95Ms,
    },
  };
}

function decideFromEvidence(comparisons, uncappedModes, cappedModes) {
  const passing = comparisons
    .filter((comparison) => comparison.allGatesPass)
    .sort(
      (left, right) =>
        right.temporalFlickerImprovement - left.temporalFlickerImprovement,
    );
  const selected = passing[0];
  const selectedMode = selected?.candidate ?? 'ultra';
  const msaa4Blocked =
    uncappedModes.msaa4.performance.summary.budgetVerdict !== 'PASS'
    || cappedModes.msaa4.performance.summary.budgetVerdict !== 'PASS';
  return {
    verdict: selected ? 'CHANGE' : 'BLOCKED',
    selectedMode,
    selectedDprMode: 'auto',
    shippingPolicy:
      'SMAA Ultra with auto DPR capped at 1.5 and about 3.34M drawing-buffer pixels',
    issueClosingCriterionMet: Boolean(selected),
    msaa4AtRetina: msaa4Blocked ? 'BLOCKED' : 'PASS',
    reason: selected
      ? `${selectedMode} passes Retina temporal, sharpness, ghost, and p95 gates.`
      : 'No tested MSAA mode improves Retina temporal stability by 10% while '
        + 'also passing the 16.7ms worst-p95 gate.',
    taaStatus: 'BLOCKED',
    taaReason:
      'No motion-vector buffer or object-motion/disocclusion history-rejection contract exists.',
    naiveHistoryStatus: 'NEGATIVE_CONTROL_ONLY',
  };
}

function createBlindSets(sourceCommit, matrix) {
  const capEntries = makeAliases(
    sourceCommit,
    'dpr-cap',
    [
      {
        imageKey: 'retina2/ultra',
        label: 'retina2/ultra',
        summary: () => ({
          diagnostics: matrixSummary('retina2', 'ultra'),
        }),
      },
      {
        imageKey: 'retina-auto/ultra',
        label: 'retina-auto/ultra',
        summary: () => ({
          diagnostics: matrixSummary('retina-auto', 'ultra'),
        }),
      },
    ],
  );
  const fallbackEntries = makeAliases(
    sourceCommit,
    'sample-fallback',
    [
      {
        imageKey: 'dpr1/msaa4',
        label: 'dpr1/msaa4 supported 4x',
        summary: () => ({
          diagnostics: matrixSummary('dpr1', 'msaa4'),
        }),
      },
      {
        imageKey: 'forced-fallback-2x/msaa4',
        label: 'dpr1/msaa4 forced to 2x capability',
        summary: () => ({
          diagnostics: {
            effectiveAa: 'msaa2',
            composerMultisampling: 2,
          },
        }),
      },
    ],
  );
  return [
    {
      name: 'dpr-cap',
      question:
        'Compare uncapped Retina DPR2 against the production DPR cap for sharpness and stability.',
      entries: capEntries,
    },
    {
      name: 'sample-fallback',
      question:
        'Compare supported 4x RGBA16F MSAA against deterministic forced 2x fallback.',
      entries: fallbackEntries,
    },
  ];

  function matrixSummary(profileName, mode) {
    const value = matrix[profileName].modes[mode];
    return {
      effectiveAa: value.diagnostics.effectiveAa,
      effectiveDpr: value.diagnostics.effectiveDpr,
      drawingBuffer: [
        value.diagnostics.drawingBufferWidth,
        value.diagnostics.drawingBufferHeight,
      ],
      visual: value.visual.summary,
      performance: value.performance.summary,
    };
  }
}

function makeAliases(sourceCommit, setName, entries) {
  return entries
    .map((entry) => ({
      ...entry,
      hash: createHash('sha256')
        .update(`rapp-fps-29:${sourceCommit}:${setName}:${entry.label}`)
        .digest('hex'),
    }))
    .sort((left, right) => left.hash.localeCompare(right.hash))
    .map((entry, index) => ({
      ...entry,
      alias: `mode-${String.fromCharCode(97 + index)}`,
    }));
}

function harnessUrl(parameters) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
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
  const result = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
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
