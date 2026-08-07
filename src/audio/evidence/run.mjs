import { spawn, spawnSync } from 'node:child_process';
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
const url = 'http://127.0.0.1:5333/src/audio/evidence/index.html';
const truePeakCeilingDbtp = -1;
const negativeControlName = 'automatic-30-no-limiter.wav';
const serverOutput = [];

let browser;
let server;
let exitCode = 0;
try {
  const ffmpeg = requireFfmpeg();
  await requirePinnedChromium();
  await rm(candidate, { recursive: true, force: true });

  server = startVite();
  await waitForVite(server);
  browser = await chromium.launch({ headless: true });
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
  if (consoleErrors.length > 0) {
    throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`);
  }

  await mkdir(candidate, { recursive: true });
  for (const [name, base64] of Object.entries(evidence.wavs)) {
    if (!/^[a-z0-9-]+\.wav$/.test(name)) {
      throw new Error(`Unsafe evidence filename: ${name}`);
    }
    await writeFile(resolve(candidate, name), Buffer.from(base64, 'base64'));
  }

  const peakMetrics = {};
  for (const name of Object.keys(evidence.wavs).sort()) {
    const path = resolve(candidate, name);
    const truePeakDbtp = measureTruePeak(path);
    const wavSamplePeakDbfs = measureWavSamplePeakDbfs(path);
    peakMetrics[name] = {
      wavSamplePeakDbfs,
      truePeakDbtp,
      intersampleOvershootDb: rounded(truePeakDbtp - wavSamplePeakDbfs),
    };
  }
  const limitedNames = Object.keys(peakMetrics)
    .filter((name) => name !== negativeControlName);
  for (const name of limitedNames) {
    assertTruePeak(name, peakMetrics[name].truePeakDbtp);
  }
  let negativeControlFailed = false;
  try {
    assertTruePeak(
      negativeControlName,
      peakMetrics[negativeControlName].truePeakDbtp,
    );
  } catch {
    negativeControlFailed = true;
  }
  if (!negativeControlFailed) {
    throw new Error('Limiter-off negative control did not fail real dBTP.');
  }
  const matrixNames = evidence.matrixWavs;
  if (!Array.isArray(matrixNames) || matrixNames.length !== 18) {
    throw new Error(`Expected 18 true-peak matrix WAVs, received ${matrixNames?.length}.`);
  }
  const worstMatrixName = [...matrixNames].sort((a, b) =>
    peakMetrics[b].truePeakDbtp - peakMetrics[a].truePeakDbtp
      || a.localeCompare(b))[0];

  const report = evidence.report;
  attachPeakMetrics(report, peakMetrics);
  report.assertions.push(
    `FFmpeg EBU R128 true peak is at or below ${truePeakCeilingDbtp.toFixed(1)} dBTP for every limiter-on WAV`,
    `44.1/48 kHz stereo L/C/R matrix passes ${matrixNames.length} sustained-burst cases at masterGain=1`,
    `limiter-off negative control exceeds ${truePeakCeilingDbtp.toFixed(1)} dBTP and fails the same assertion`,
  );
  const worstMatrixCase = report.truePeakStressMatrix.cases.find(
    (matrixCase) => matrixCase.wavName === worstMatrixName,
  );
  report.truePeakStressMatrix.ceilingDbtp = truePeakCeilingDbtp;
  report.truePeakStressMatrix.worstCase = {
    wavName: worstMatrixName,
    sampleRate: worstMatrixCase.sampleRate,
    seed: worstMatrixCase.seed,
    position: worstMatrixCase.position,
    ...peakMetrics[worstMatrixName],
  };
  const retainedNames = new Set(
    Object.keys(evidence.wavs)
      .filter((name) => !matrixNames.includes(name)),
  );
  retainedNames.add(worstMatrixName);
  report.truePeakAnalysis = {
    standard: 'ITU-R BS.1770 true peak via FFmpeg ebur128=peak=true',
    ceilingDbtp: truePeakCeilingDbtp,
    ffmpegVersion: ffmpeg.version,
    command: 'ffmpeg -hide_banner -nostats -i <wav> -filter_complex ebur128=peak=true -f null -',
    files: Object.fromEntries(
      Object.entries(peakMetrics).map(([name, metrics]) => [
        name,
        {
          ...metrics,
          passes: name === negativeControlName
            ? false
            : metrics.truePeakDbtp <= truePeakCeilingDbtp,
          retained: retainedNames.has(name),
        },
      ]),
    ),
  };
  report.browser = {
    engine: 'Playwright Chromium',
    version: browser.version(),
    playwrightVersion,
    source: 'playwright-bundled',
  };
  report.consoleErrors = consoleErrors;

  for (const name of matrixNames) {
    if (name !== worstMatrixName) {
      await rm(resolve(candidate, name), { force: true });
    }
  }
  await writeFile(
    resolve(candidate, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await rm(generated, { recursive: true, force: true });
  await rename(candidate, generated);

  process.stdout.write(
    `Analyzed ${Object.keys(evidence.wavs).length} WAV renders; retained `
      + `${retainedNames.size}, worst matrix ${worstMatrixName} `
      + `${peakMetrics[worstMatrixName].truePeakDbtp.toFixed(1)} dBTP.\n`,
  );
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

function requireFfmpeg() {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      'FFmpeg is required for standards-compatible EBU R128 true-peak evidence; refusing to generate evidence.',
    );
  }
  if (result.status !== 0) {
    throw new Error(`FFmpeg capability check failed: ${result.stderr.trim()}`);
  }
  return { version: result.stdout.split(/\r?\n/, 1)[0].trim() };
}

async function requirePinnedChromium() {
  try {
    await access(chromium.executablePath(), fsConstants.X_OK);
  } catch {
    throw new Error(
      'Pinned Playwright Chromium is unavailable; run `npx playwright install chromium`. Refusing installed-Chrome fallback.',
    );
  }
}

function startVite() {
  const child = spawn(vite, [
    '--host', '127.0.0.1',
    '--port', '5333',
    '--strictPort',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  child.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  return child;
}

function measureTruePeak(path) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i', path,
    '-filter_complex', 'ebur128=peak=true',
    '-f', 'null',
    '-',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`FFmpeg true-peak analysis failed for ${path}:\n${result.stderr}`);
  }
  const match = result.stderr.match(
    /True peak:\s+Peak:\s+([+-]?\d+(?:\.\d+)?|-inf)\s+dBFS/,
  );
  if (!match) throw new Error(`Could not parse FFmpeg true peak for ${path}.`);
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

function measureWavSamplePeakDbfs(path) {
  const wav = readFileSync(path);
  let offset = 12;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataLength = length;
      break;
    }
    offset += 8 + length + (length % 2);
  }
  if (dataStart < 0) throw new Error(`WAV data chunk not found: ${path}`);

  let samplePeak = 0;
  const end = Math.min(wav.length, dataStart + dataLength);
  for (let index = dataStart; index + 1 < end; index += 2) {
    samplePeak = Math.max(samplePeak, Math.abs(wav.readInt16LE(index)));
  }
  return samplePeak === 0
    ? Number.NEGATIVE_INFINITY
    : rounded(20 * Math.log10(samplePeak / 0x8000));
}

function assertTruePeak(name, truePeakDbtp) {
  if (!Number.isFinite(truePeakDbtp) || truePeakDbtp > truePeakCeilingDbtp) {
    throw new Error(
      `${name} true peak ${truePeakDbtp.toFixed(1)} dBTP exceeds `
        + `${truePeakCeilingDbtp.toFixed(1)} dBTP.`,
    );
  }
}

function attachPeakMetrics(report, peakMetrics) {
  const targets = {
    'shot-near.wav': report.shots.near,
    'shot-far.wav': report.shots.far,
    'footsteps-concrete.wav': report.footsteps,
    'automatic-30.wav': report.automaticFire30,
    [negativeControlName]: report.disabledLimiterNegativeControl,
  };
  for (const surface of Object.keys(report.impacts)) {
    targets[`impact-${surface}.wav`] = report.impacts[surface];
  }
  for (const matrixCase of report.truePeakStressMatrix.cases) {
    targets[matrixCase.wavName] = matrixCase;
  }

  for (const [name, target] of Object.entries(targets)) {
    Object.assign(target.analysis, peakMetrics[name]);
  }
}

function rounded(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

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
