import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    return match ? [[match[1], match[2]]] : [];
  }),
);
const url = args.url ?? 'http://127.0.0.1:5311/src/player/harness.html';
const out = args.out ?? 'src/player/player-harness-results.json';

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

const report = { ...result.report, consoleErrors: errors };
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed && errors.length === 0 ? 0 : 1);
