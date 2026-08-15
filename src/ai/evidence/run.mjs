/**
 * Browser-free evidence runner for the enemy AI.
 *
 * Compiles the deterministic core plus `fixtures.ts` with the project's own
 * TypeScript, runs it in plain Node (no renderer, no GPU, no browser), writes
 * `report.json`, prints a human summary, and exits non-zero if any section
 * fails. A reviewer can reproduce every logic claim with:
 *
 *   node src/ai/evidence/run.mjs
 *
 * The transition-reachability gate is the point: the run fails if any declared
 * edge never fires OR if any edge fires that is not declared.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const buildDir = resolve(repoRoot, '.ai-build');
const tsconfig = resolve(here, 'tsconfig.evidence.json');
const reportPath = resolve(here, 'report.json');

const tsc = resolve(repoRoot, 'node_modules/.bin/tsc');
const compile = spawnSync(tsc, ['-p', tsconfig], { cwd: repoRoot, encoding: 'utf8' });
if (compile.status !== 0) {
  process.stderr.write('REFUSING: evidence core failed to compile.\n');
  process.stderr.write((compile.stdout ?? '') + (compile.stderr ?? ''));
  process.exit(11);
}

// Emitted .js are ES modules; declare the build dir as such so Node loads them
// without the CommonJS-reparse warning.
mkdirSync(buildDir, { recursive: true });
writeFileSync(resolve(buildDir, 'package.json'), JSON.stringify({ type: 'module' }));

const fixturesUrl = new URL('../../../.ai-build/evidence/fixtures.js', import.meta.url);
const { buildReport } = await import(fixturesUrl.href);
const report = buildReport();

writeFileSync(reportPath, JSON.stringify(report, null, 2));

// ── Human summary ────────────────────────────────────────────────────────
const line = (s) => process.stdout.write(s + '\n');
line('');
line('enemy-AI evidence  —  fixed step ' + report.fixedStepHz + ' Hz');
line('='.repeat(72));

line('\nTRANSITION REACHABILITY');
line('  from            to            reason           fired-by                 t(s)');
line('  ' + '-'.repeat(84));
for (const r of report.reachability.rows) {
  const cell = (v, w) => String(v).padEnd(w);
  const status = r.firedBy ? '' : '   << NEVER FIRED';
  const fromCell = r.observedFroms && r.observedFroms.length
    ? '* (' + r.observedFroms.join(',') + ')'
    : r.from;
  line('  ' + cell(fromCell, 14) + '  ' + cell(r.to, 12) + '  ' + cell(r.reason, 15)
    + '  ' + cell(r.firedBy ?? '—', 22) + '  ' + (r.time ?? '—') + status);
}

line('\nLINE OF SIGHT (expected vs actual)');
for (const c of report.lineOfSight.cases) {
  const mark = c.expected === c.actual ? 'ok ' : 'BAD';
  line('  [' + mark + '] ' + c.name.padEnd(30) + ' expect=' + String(c.expected).padEnd(5)
    + ' got=' + String(c.actual).padEnd(5) + '  ' + c.detail);
}

line('\nDETERMINISM');
line('  two runs identical: ' + report.determinism.identical
  + '  (' + report.determinism.transitions + ' transitions, '
  + report.determinism.shotsFired + ' shots compared)');

line('\nRENDER-RATE INDEPENDENCE');
line('  rates: ' + report.renderRate.rates.join(', ') + ' fps  over '
  + report.renderRate.targetSteps + ' fixed steps');
line('  all schedules identical: ' + report.renderRate.identical
  + '  (' + report.renderRate.transitions + ' transitions)');

line('\nCPU COST (worst of ' + report.cpu.trials + ' trials, 1 enemy)');
line('  per fixed step : ' + report.cpu.perStepMicros + ' µs');
line('  per 60fps frame: ' + report.cpu.perFrame60Micros + ' µs  (budget '
  + report.cpu.budgetMicros + ' µs)  ->  ' + (report.cpu.perFrame60Micros < report.cpu.budgetMicros ? 'PASS' : 'FAIL'));

line('\n' + '='.repeat(72));
if (report.ok) {
  line('RESULT: PASS — every section green. report.json written.');
} else {
  line('RESULT: FAIL');
  for (const f of report.failures) line('  - ' + f);
}
line('');

process.exit(report.ok ? 0 : 1);
