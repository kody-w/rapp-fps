/**
 * Browser-free proof runner for the campaign library.
 *
 * Node 20 cannot execute the project's `.ts` sources directly (their `.js`
 * import specifiers point at `.ts` files, resolved by a bundler, not Node), so
 * — exactly like `src/ai/evidence/run.mjs` — this compiles `run.ts` and its
 * transitive imports with the project's own TypeScript into the gitignored
 * `dist/campaign/`, marks that tree as ESM, dynamic-imports the emitted entry,
 * runs the deterministic suite, prints a human summary, archives
 * `evidence/report.json`, and exits non-zero on any failure.
 *
 *   node src/campaign/test/run-campaign.mjs
 *
 * No renderer, no DOM, no network, no account — pure logic over the real
 * modules, reproducible on any machine with the repo checked out.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const buildDir = resolve(repoRoot, 'dist/campaign');
const tsconfig = resolve(here, 'tsconfig.test.json');
const evidenceDir = resolve(here, '../evidence');
const reportPath = resolve(evidenceDir, 'report.json');

const tsc = resolve(repoRoot, 'node_modules/.bin/tsc');
const compile = spawnSync(tsc, ['-p', tsconfig], { cwd: repoRoot, encoding: 'utf8' });
if (compile.status !== 0) {
  process.stderr.write('REFUSING: campaign proof failed to compile.\n');
  process.stderr.write((compile.stdout ?? '') + (compile.stderr ?? ''));
  process.exit(11);
}

// Emitted .js are ES modules; the repo root has no "type":"module", so declare
// the build dir as such or Node reparses them as CommonJS and fails.
mkdirSync(buildDir, { recursive: true });
writeFileSync(resolve(buildDir, 'package.json'), JSON.stringify({ type: 'module' }));

const entryUrl = new URL('../../../dist/campaign/campaign/test/run.js', import.meta.url);
const { buildReport } = await import(entryUrl.href);
const report = buildReport();

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));

// ── Human summary ────────────────────────────────────────────────────────
const line = (s) => process.stdout.write(s + '\n');
line('');
line('campaign library evidence  —  browser-free deterministic proof');
line('='.repeat(72));
line('');
for (const t of report.tests) {
  const mark = t.pass ? 'ok ' : 'BAD';
  line('  [' + mark + '] ' + t.name);
  if (!t.pass) for (const f of t.failures) line('        - ' + f);
}
line('');
line('='.repeat(72));
line(`  ${report.passed}/${report.total} cases passed`);
if (report.ok) {
  line('RESULT: PASS — every case green. evidence/report.json written.');
} else {
  line('RESULT: FAIL');
  for (const f of report.failures) line('  - ' + f);
}
line('');

process.exit(report.ok ? 0 : 1);
