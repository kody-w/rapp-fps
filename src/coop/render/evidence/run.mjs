/**
 * Browser-free proof runner for the co-op split-screen render library. — Refs #71
 *
 * Exactly like `src/ai/evidence/run.mjs` and `src/campaign/test/run-campaign.mjs`:
 * Node 20 cannot execute the project's `.ts` sources directly (their `.js`
 * import specifiers resolve to `.ts` files via a bundler, not Node), so this
 * compiles `fixtures.ts` and its transitive library imports with the project's
 * own TypeScript into the gitignored `dist/coop-render/`, marks that tree as
 * ESM, dynamic-imports the emitted fixtures, runs the deterministic suite,
 * prints a human summary, and exits non-zero on any failure.
 *
 *   node src/coop/render/evidence/run.mjs
 *
 * No renderer, no GPU, no DOM — pure arithmetic plus THREE's camera/vector maths
 * over the real library modules, reproducible on any checkout.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const buildDir = resolve(repoRoot, 'dist/coop-render');
const tsconfig = resolve(here, 'tsconfig.evidence.json');
const reportPath = resolve(here, 'report.json');

const tsc = resolve(repoRoot, 'node_modules/.bin/tsc');
const compile = spawnSync(tsc, ['-p', tsconfig], { cwd: repoRoot, encoding: 'utf8' });
if (compile.status !== 0) {
  process.stderr.write('REFUSING: co-op render evidence failed to compile.\n');
  process.stderr.write((compile.stdout ?? '') + (compile.stderr ?? ''));
  process.exit(11);
}

// Emitted .js are ES modules; the repo root has no "type":"module", so declare
// the build dir as such or Node reparses them as CommonJS and fails.
mkdirSync(buildDir, { recursive: true });
writeFileSync(resolve(buildDir, 'package.json'), JSON.stringify({ type: 'module' }));

const entryUrl = new URL('../../../../dist/coop-render/evidence/fixtures.js', import.meta.url);
const { buildReport } = await import(entryUrl.href);
const report = buildReport();

writeFileSync(reportPath, JSON.stringify(report, null, 2));

// ── Human summary ──────────────────────────────────────────────────────────
const line = (s) => process.stdout.write(s + '\n');
line('');
line('co-op split-screen render evidence  —  browser-free deterministic proof');
line('='.repeat(72));
line(`three r${report.threeRevision}`);
line('');
for (const section of report.sections) {
  const mark = section.pass ? 'ok ' : 'BAD';
  line(`  [${mark}] ${section.name}`);
  if (!section.pass) for (const f of section.failures) line(`        - ${f}`);
}
line('');
line('='.repeat(72));
line(`  ${report.passed}/${report.total} sections passed`);
if (report.ok) {
  line('RESULT: PASS — every section green. evidence/report.json written.');
} else {
  line('RESULT: FAIL');
  for (const f of report.failures) line('  - ' + f);
}
line('');

process.exit(report.ok ? 0 : 1);
