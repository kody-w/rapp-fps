#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import {
  chunkBudgetFor,
  enforceChunkBudgets,
} from '../vite.config.mjs';

const ASSETS = new URL('../dist/assets/', import.meta.url);
// Deployed campaign-menu parent, recompressed with the same gzip level 9.
const INITIAL_BASELINE_GZIP_BYTES = 409_212;
const MAX_INITIAL_GZIP_GROWTH = 1.02;
const MAX_COOP_GZIP_BYTES = 12_000;

const chunks = readdirSync(ASSETS)
  .filter((name) => name.endsWith('.js'))
  .map((name) => {
    const code = readFileSync(new URL(name, ASSETS));
    return {
      name,
      rawBytes: code.byteLength,
      gzipBytes: gzipSync(code, { level: 9 }).byteLength,
      budgetBytes: chunkBudgetFor(`assets/${name}`),
      hashed: /-[A-Za-z0-9_-]{8}\.js$/.test(name),
    };
  });

assert.equal(chunks.length, 5, `expected app/post/three/shared/coop chunks, got ${chunks.length}`);
for (const prefix of ['index-', 'post-', 'three-', 'StaticWorldCollider-', 'coop-']) {
  assert(
    chunks.some((chunk) => chunk.name.startsWith(prefix)),
    `missing ${prefix} chunk`,
  );
}
for (const chunk of chunks) {
  assert(chunk.hashed, `${chunk.name} is not content-hash named`);
  assert(
    chunk.rawBytes <= chunk.budgetBytes,
    `${chunk.name} ${chunk.rawBytes} > ${chunk.budgetBytes}`,
  );
}

const coopChunk = chunks.find((chunk) => chunk.name.startsWith('coop-'));
assert(coopChunk, 'missing lazy co-op chunk');
assert(
  coopChunk.gzipBytes <= MAX_COOP_GZIP_BYTES,
  `co-op gzip ${coopChunk.gzipBytes} > ${MAX_COOP_GZIP_BYTES}`,
);
const initialChunks = chunks.filter((chunk) => !chunk.name.startsWith('coop-'));
const initialGzipBytes = initialChunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
const gzipGrowth = initialGzipBytes / INITIAL_BASELINE_GZIP_BYTES;
assert(
  gzipGrowth <= MAX_INITIAL_GZIP_GROWTH,
  `initial gzip growth ${((gzipGrowth - 1) * 100).toFixed(2)}% exceeds 2%`,
);

let negativeControl = '';
try {
  const plugin = enforceChunkBudgets();
  plugin.generateBundle.call(
    { error: (message) => { throw new Error(message); } },
    {},
    {
      'assets/index-negative.js': {
        type: 'chunk',
        code: 'x'.repeat(500_001),
      },
    },
  );
} catch (error) {
  negativeControl = String(error);
}
assert(
  negativeControl.includes('500001') && negativeControl.includes('500000'),
  'oversized app-chunk negative control did not fail with measured limits',
);

console.log(JSON.stringify({
  passed: true,
  chunks,
  initialGzipBytes,
  initialBaselineGzipBytes: INITIAL_BASELINE_GZIP_BYTES,
  initialGzipGrowthPercent: (gzipGrowth - 1) * 100,
  coopGzipBytes: coopChunk.gzipBytes,
  coopGzipBudgetBytes: MAX_COOP_GZIP_BYTES,
  negativeControl,
}, null, 2));
