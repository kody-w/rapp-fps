#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import {
  chunkBudgetFor,
  enforceChunkBudgets,
} from '../vite.config.mjs';

const ASSETS = new URL('../dist/assets/', import.meta.url);
const BASELINE_GZIP_BYTES = 391_330;
const MAX_GZIP_GROWTH = 1.05;

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

assert.equal(chunks.length, 3, `expected app/post/three chunks, got ${chunks.length}`);
for (const prefix of ['index-', 'post-', 'three-']) {
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

const totalGzipBytes = chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
const gzipGrowth = totalGzipBytes / BASELINE_GZIP_BYTES;
assert(
  gzipGrowth <= MAX_GZIP_GROWTH,
  `gzip growth ${((gzipGrowth - 1) * 100).toFixed(2)}% exceeds 5%`,
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
  totalGzipBytes,
  baselineGzipBytes: BASELINE_GZIP_BYTES,
  gzipGrowthPercent: (gzipGrowth - 1) * 100,
  negativeControl,
}, null, 2));
