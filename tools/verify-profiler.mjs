/**
 * Negative controls for the frame profiler. — #7
 *
 * This verifies what the instrument claims, not whether the current scene is
 * fast:
 *
 *  - reports contain completed hardware GPU queries and separate CPU/rAF clocks;
 *  - the budget is max(CPU, GPU), never the rAF callback interval;
 *  - the legacy `frameMsMedian` field is absent, so a consumer cannot silently
 *    keep reading browser scheduling cadence;
 *  - when GPU timer support is withheld, shoot refuses with exit 4 and writes
 *    no success-shaped report.
 */

import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET_URL = process.env.FPS_URL ?? 'http://127.0.0.1:5273/';
const OUT = 'shots/profiler-verification';
const INVALID_OUT = `${OUT}-invalid-budget`;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/shoot.mjs', ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

rmSync(`${ROOT}/${OUT}`, { recursive: true, force: true });
rmSync(`${ROOT}/${OUT}-unsupported`, { recursive: true, force: true });
rmSync(`${ROOT}/${INVALID_OUT}`, { recursive: true, force: true });

const measured = await run([`--url=${TARGET_URL}`, `--out=${OUT}`, '--budgetMs=1000']);
assert(measured.code === 0, `normal capture failed (${measured.code}): ${measured.stderr}`);

const report = JSON.parse(readFileSync(`${ROOT}/${OUT}/report.json`, 'utf8'));
const perf = report.performance;
assert(perf.gpuFrameMs.samples >= 120, `only ${perf.gpuFrameMs.samples} GPU samples`);
assert(perf.budgetFrameMs.samples >= 120, `only ${perf.budgetFrameMs.samples} paired samples`);
assert(perf.gpuCounterBits > 0, `timer query reports ${perf.gpuCounterBits} counter bits`);
assert(perf.cpuFrameMs.samples >= 120, `only ${perf.cpuFrameMs.samples} CPU samples`);
assert(perf.gpuDisjointCount === 0, `GPU was disjoint ${perf.gpuDisjointCount} time(s)`);
assert(perf.gpuFrameMs.median > 0, 'GPU median was not positive');
assert(perf.cpuFrameMs.median > 0, 'CPU median was not positive');
assert(perf.rafIntervalMs.median > 0, 'rAF cadence was not recorded');
assert(perf.budgetFrameMsMedian === perf.budgetFrameMs.median, 'budget median is not paired');
assert(perf.budgetFrameMsP95 === perf.budgetFrameMs.p95, 'budget p95 is not paired');
assert(!('frameMsMedian' in perf), 'legacy rAF-as-frame-cost field still exists');

mkdirSync(`${ROOT}/${OUT}-unsupported`, { recursive: true });
writeFileSync(`${ROOT}/${OUT}-unsupported/report.json`, '{"stale":"green"}');
const unsupported = await run([
  `--url=${TARGET_URL}`,
  `--out=${OUT}-unsupported`,
  '--forceNoGpuTimer=1',
]);
assert(unsupported.code === 4, `unsupported timer exited ${unsupported.code}, expected 4`);
assert(
  !existsSync(`${ROOT}/${OUT}-unsupported/report.json`),
  'unsupported timer left the pre-existing success-shaped report',
);
assert(
  unsupported.stderr.includes('GPU frame cost is UNVERIFIED'),
  'unsupported refusal did not name the claim as UNVERIFIED',
);

mkdirSync(`${ROOT}/${INVALID_OUT}`, { recursive: true });
writeFileSync(`${ROOT}/${INVALID_OUT}/report.json`, '{"stale":"green"}');
const invalidBudget = await run([
  `--url=${TARGET_URL}`,
  `--out=${INVALID_OUT}`,
  '--budgetMs=16.7ms',
]);
assert(invalidBudget.code === 8, `invalid budget exited ${invalidBudget.code}, expected 8`);
assert(
  !existsSync(`${ROOT}/${INVALID_OUT}/report.json`),
  'invalid budget left the pre-existing success-shaped report',
);
assert(
  invalidBudget.stderr.includes('invalid frame budget'),
  'invalid-budget refusal did not name the invalid input',
);

console.log(JSON.stringify({
  passed: true,
  gpuMedianMs: perf.gpuFrameMs.median,
  cpuMedianMs: perf.cpuFrameMs.median,
  rafMedianMs: perf.rafIntervalMs.median,
  gpuSamples: perf.gpuFrameMs.samples,
  unsupportedExit: unsupported.code,
  invalidBudgetExit: invalidBudget.code,
}, null, 2));
