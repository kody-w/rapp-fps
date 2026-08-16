#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = resolve(root, 'dist/coop-targeting');
const tsc = resolve(root, 'node_modules/.bin/tsc');
const compile = spawnSync(tsc, [
  '-p',
  resolve(here, 'tsconfig.targeting.json'),
], { cwd: root, encoding: 'utf8' });
if (compile.status !== 0) {
  process.stderr.write((compile.stdout ?? '') + (compile.stderr ?? ''));
  process.exit(11);
}
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'package.json'), JSON.stringify({ type: 'module' }));
const moduleUrl = pathToFileURL(
  resolve(out, 'coop/evidence/targeting.js'),
).href;
const { buildTargetingReport } = await import(moduleUrl);
const report = buildTargetingReport();
for (const check of report.checks) {
  console.log(`[${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
}
console.log(`\n${report.ok ? 'AI TARGETING VERIFIED' : 'AI TARGETING FAILED'}`);
process.exit(report.ok ? 0 : 1);
