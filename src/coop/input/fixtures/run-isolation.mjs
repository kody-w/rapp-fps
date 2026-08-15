/**
 * Browser-free proof runner for the co-op gamepad input library.
 *
 * Node 20 cannot execute the project's `.ts` sources directly (their `.js`
 * import specifiers resolve to `.ts` files via a bundler, not Node), so — like
 * `src/campaign/test/run-campaign.mjs` — this compiles the deterministic
 * isolation fixture and its transitive library imports with the project's own
 * TypeScript into the gitignored `dist/coop-input/`, marks that tree as ESM,
 * dynamic-imports the emitted entry, runs the suite over the REAL shipped
 * modules, prints a human summary grouped by scenario, archives
 * `evidence/report.json`, and exits non-zero on any failure.
 *
 *   node src/coop/input/fixtures/run-isolation.mjs
 *
 * No renderer, no DOM, no gamepad hardware, no network — pure logic over the
 * exact modules that ship, reproducible on any machine with the repo checked
 * out.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const buildDir = resolve(repoRoot, 'dist/coop-input');
const tsconfig = resolve(here, 'tsconfig.test.json');
const evidenceDir = resolve(here, '../evidence');
const reportPath = resolve(evidenceDir, 'report.json');

const tsc = resolve(repoRoot, 'node_modules/.bin/tsc');
const compile = spawnSync(tsc, ['-p', tsconfig], { cwd: repoRoot, encoding: 'utf8' });
if (compile.status !== 0) {
  process.stderr.write('REFUSING: co-op input proof failed to compile.\n');
  process.stderr.write((compile.stdout ?? '') + (compile.stderr ?? ''));
  process.exit(11);
}

// Emitted .js are ES modules; the repo root has no "type":"module", so declare
// the build dir as such or Node reparses them as CommonJS and fails.
mkdirSync(buildDir, { recursive: true });
writeFileSync(resolve(buildDir, 'package.json'), JSON.stringify({ type: 'module' }));

const entry = resolve(buildDir, 'coop/input/fixtures/two-slot-isolation.js');
const { runIsolationSuite } = await import(pathToFileUrl(entry));
const report = runIsolationSuite();

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

// ── Human summary, grouped by scenario ──────────────────────────────────────
const line = (s) => process.stdout.write(s + '\n');
line('');
line('co-op gamepad input  —  deterministic two-slot isolation proof');
line('='.repeat(72));
line('');

const categories = [...new Set(report.checks.map((x) => x.category))];
for (const category of categories) {
  const rows = report.checks.filter((x) => x.category === category);
  const bad = rows.filter((x) => !x.pass).length;
  line(`  ${category}  (${rows.length - bad}/${rows.length})`);
  for (const row of rows) {
    const mark = row.pass ? 'ok ' : 'BAD';
    line(`    [${mark}] ${row.name}`);
    if (!row.pass) line(`          ${row.detail}`);
  }
  line('');
}

line('='.repeat(72));
line(`  ${report.passed}/${report.total} checks passed`);
if (report.ok) {
  line('RESULT: PASS — every check green. evidence/report.json written.');
} else {
  line('RESULT: FAIL');
  for (const f of report.failures) line('  - ' + f);
}
line('');

process.exit(report.ok ? 0 : 1);

function pathToFileUrl(p) {
  return new URL(`file://${p}`).href;
}
