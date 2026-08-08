import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const runner = resolve(here, 'run.mjs');
const trackedFixture = resolve(here, 'README.md');

assert.equal(gitStatus(), '', 'negative controls require a clean tracked tree');

const invalidMode = spawnSync(
  process.execPath,
  [runner, '--modes=not-a-mode', '--preflight-only'],
  { cwd: root, encoding: 'utf8' },
);
assert.notEqual(invalidMode.status, 0, 'invalid AA mode unexpectedly passed');
assert.match(
  `${invalidMode.stdout}\n${invalidMode.stderr}`,
  /Unsupported evidence AA mode "not-a-mode"/,
);

const original = await readFile(trackedFixture);
let dirtyTree;
try {
  await writeFile(
    trackedFixture,
    Buffer.concat([original, Buffer.from('\n<!-- dirty-tree-control -->\n')]),
  );
  dirtyTree = spawnSync(
    process.execPath,
    [runner, '--preflight-only'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(dirtyTree.status, 0, 'dirty tracked tree unexpectedly passed');
  assert.match(
    `${dirtyTree.stdout}\n${dirtyTree.stderr}`,
    /REFUSING: tracked files are staged or modified/,
  );
} finally {
  await writeFile(trackedFixture, original);
}

assert.equal(gitStatus(), '', 'dirty-tree fixture was not restored exactly');
process.stdout.write(`${JSON.stringify({
  invalidAaMode: {
    rejected: true,
    exitCode: invalidMode.status,
  },
  dirtyTrackedTree: {
    rejected: true,
    exitCode: dirtyTree.status,
  },
}, null, 2)}\n`);

function gitStatus() {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=no'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}
