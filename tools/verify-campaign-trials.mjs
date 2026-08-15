#!/usr/bin/env node
/**
 * Runs the production slice judge three independent times for every campaign
 * mission. One warm or favorable GPU trial can never qualify a mission.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(raw);
  if (!match) {
    console.error(`REFUSING: unparseable argument "${raw}". Expected --key=value.`);
    process.exit(9);
  }
  args.set(match[1], match[2]);
}

const TARGET = args.get('url');
if (!TARGET) {
  console.error('REFUSING: --url is required; campaign trials never guess a branch or port.');
  process.exit(9);
}
const OUT = args.get('out') ?? 'shots/campaign-trials';
const BUDGET_MS = Number(args.get('budget') ?? 16.7);
if (!Number.isFinite(BUDGET_MS) || BUDGET_MS <= 0) {
  console.error(`REFUSING: --budget must be positive, got "${args.get('budget')}".`);
  process.exit(9);
}

const MISSIONS = ['cargo-breach', 'relay-blackout', 'foundry-last-light'];
const TRIALS = 3;

function missionUrl(id) {
  const url = new URL(TARGET);
  url.searchParams.set('mission', id);
  // Fixture selection bypasses progression locks without mutating persisted
  // completion. tools/verify-campaign.mjs separately proves that invariant.
  url.searchParams.set('campaignFixture', '1');
  return url.href;
}

function qualifies(reports) {
  return reports.length === TRIALS
    && reports.every((report) => (
      report.exitCode === 0
      && report.verdict === 'SLICE VERIFIED'
      && report.passed === 11
      && report.failed === 0
      && report.unobserved === 0
      && report.consoleErrors.length === 0
      && Number.isFinite(report.frameMsP95)
      && report.frameMsP95 <= BUDGET_MS
    ));
}

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, 'campaign-trials.json'), { force: true });

const result = {
  at: new Date().toISOString(),
  target: TARGET,
  budgetMs: BUDGET_MS,
  trialsPerMission: TRIALS,
  missions: [],
};

const contractOut = join(OUT, 'contract');
rmSync(contractOut, { recursive: true, force: true });
const contractRun = spawnSync(
  process.execPath,
  [new URL('./verify-campaign.mjs', import.meta.url).pathname],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FPS_URL: TARGET,
      CAMPAIGN_OUT: contractOut,
    },
  },
);
let contractReport = null;
try {
  contractReport = JSON.parse(readFileSync(join(contractOut, 'campaign.json'), 'utf8'));
} catch (error) {
  contractReport = {
    verdict: 'MISSING REPORT',
    failure: error instanceof Error ? error.message : String(error),
  };
}
result.contract = {
  verdict: contractReport.verdict,
  exitCode: contractRun.status,
  failure: contractReport.failure,
  stdoutTail: contractRun.stdout.trim().split('\n').slice(-10),
  stderrTail: contractRun.stderr.trim().split('\n').slice(-10),
};
if (contractRun.status !== 0 || contractReport.verdict !== 'PASS') {
  result.verdict = 'REFUSED';
  writeFileSync(
    join(OUT, 'campaign-trials.json'),
    JSON.stringify(result, null, 2),
  );
  console.error('CAMPAIGN TRIALS REFUSED — campaign identity/progression contract did not pass.');
  process.exit(1);
}

let failed = false;
for (const missionId of MISSIONS) {
  const reports = [];
  for (let trial = 1; trial <= TRIALS; trial += 1) {
    const trialOut = join(OUT, missionId, `trial-${trial}`);
    rmSync(trialOut, { recursive: true, force: true });
    mkdirSync(trialOut, { recursive: true });
    const run = spawnSync(
      process.execPath,
      [
        new URL('./verify-slice.mjs', import.meta.url).pathname,
        `--url=${missionUrl(missionId)}`,
        `--out=${trialOut}`,
        `--budget=${BUDGET_MS}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const reportPath = join(trialOut, 'slice.json');
    let report = null;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (error) {
      report = {
        verdict: 'MISSING REPORT',
        reason: error instanceof Error ? error.message : String(error),
        passed: 0,
        failed: 1,
        unobserved: 0,
        consoleErrors: [],
        frameMsP95: null,
      };
    }
    reports.push({
      ...report,
      trial,
      exitCode: run.status,
      stdoutTail: run.stdout.trim().split('\n').slice(-13),
      stderrTail: run.stderr.trim().split('\n').slice(-10),
    });
    const status = run.status === 0 && report.verdict === 'SLICE VERIFIED'
      ? 'PASS'
      : 'FAIL';
    console.log(
      `${status} ${missionId} trial ${trial}: ${report.verdict}, `
        + `p95=${Number.isFinite(report.frameMsP95) ? report.frameMsP95.toFixed(3) : 'unobserved'}ms`,
    );
  }

  const qualified = qualifies(reports);
  const worstP95 = Math.max(...reports.map((report) => (
    Number.isFinite(report.frameMsP95) ? report.frameMsP95 : Infinity
  )));
  result.missions.push({
    id: missionId,
    qualified,
    worstP95: Number.isFinite(worstP95) ? worstP95 : null,
    reports,
  });
  failed ||= !qualified;
}

// Mutation proof for this aggregation layer: one otherwise-green over-budget
// run must invalidate the full three-trial qualification.
const syntheticGreen = {
  exitCode: 0,
  verdict: 'SLICE VERIFIED',
  passed: 11,
  failed: 0,
  unobserved: 0,
  consoleErrors: [],
  frameMsP95: BUDGET_MS - 1,
};
assert.equal(
  qualifies([
    syntheticGreen,
    syntheticGreen,
    { ...syntheticGreen, frameMsP95: BUDGET_MS + 0.001 },
  ]),
  false,
  'over-budget negative control did not invalidate three-trial qualification',
);
result.negativeControl = `one ${(BUDGET_MS + 0.001).toFixed(3)}ms synthetic trial rejected the three-trial set`;
result.verdict = failed ? 'FAILED' : 'CAMPAIGN TRIALS VERIFIED';

writeFileSync(
  join(OUT, 'campaign-trials.json'),
  JSON.stringify(result, null, 2),
);

if (failed) {
  console.error('CAMPAIGN TRIALS FAILED — at least one mission lacked three clean 11/11 runs.');
  process.exit(1);
}
console.log('CAMPAIGN TRIALS VERIFIED — 9/9 gameplay runs qualified at worst-case p95.');
