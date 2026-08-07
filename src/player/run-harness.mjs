import { rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SUPPORTED_ARGS = new Set(['url', 'out']);

function parseArgs(argv) {
  const values = {};
  const errors = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      errors.push(`unexpected positional argument "${token}"`);
      continue;
    }
    const equals = /^--([^=]+)=(.*)$/.exec(token);
    const key = equals ? equals[1] : token.slice(2);
    let value = equals?.[2];
    if (!SUPPORTED_ARGS.has(key)) {
      errors.push(`unknown option "--${key}"`);
      continue;
    }
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`option "--${key}" requires a value`);
        continue;
      }
      value = next;
      index++;
    }
    values[key] = value;
  }
  return { values, errors };
}

const parsed = parseArgs(process.argv.slice(2));
const args = parsed.values;
if (!args.url) parsed.errors.push('option "--url" is required');
if (args.url) {
  try {
    const target = new URL(args.url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      parsed.errors.push(`option "--url" requires http or https, got "${args.url}"`);
    }
  } catch {
    parsed.errors.push(`option "--url" is not a valid URL: "${args.url}"`);
  }
}
if (parsed.errors.length > 0) {
  console.error(`REFUSING: invalid arguments:\n- ${parsed.errors.join('\n- ')}`);
  console.error('Usage: node src/player/run-harness.mjs --url=http://127.0.0.1:PORT/src/player/harness.html [--out=path]');
  process.exit(9);
}

const url = args.url;
const out = args.out ?? 'src/player/player-harness-results.json';
rmSync(out, { force: true });
console.log(`Harness target URL: ${url}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => window.__PLAYER_HARNESS__ || window.__PLAYER_HARNESS_ERROR__,
  null,
  { timeout: 60_000 },
);

const result = await page.evaluate(() => ({
  report: window.__PLAYER_HARNESS__ ?? null,
  error: window.__PLAYER_HARNESS_ERROR__ ?? null,
}));
await browser.close();

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (!result.report) {
  console.error('Player harness produced no report.');
  process.exit(1);
}

const report = { ...result.report, targetUrl: url, consoleErrors: errors };
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed && errors.length === 0 ? 0 : 1);
