import { chromium } from 'playwright';

const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const baseUrl = urlArg?.slice('--url='.length)
  ?? 'http://127.0.0.1:5347/src/weapons/test/recoil.html';

const browser = await chromium.launch();
const summaries = [];
let failed = false;

try {
  for (const test of [
    { name: 'positive', query: '', expected: 'passed' },
    { name: 'constant-pattern negative control', query: '?negative=constant', expected: 'failed' },
  ]) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(`${baseUrl}${test.query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__RECOIL_RESULT__ !== undefined);
    const result = await page.evaluate(() => window.__RECOIL_RESULT__);
    await page.close();

    const collectionOk = result.collectionErrors.length === 0 && pageErrors.length === 0;
    const statusOk = result.status === test.expected;
    const negativeHasAssertions = test.expected !== 'failed' || result.failures.length > 0;
    if (!collectionOk || !statusOk || !negativeHasAssertions) failed = true;

    summaries.push({
      test: test.name,
      expectedStatus: test.expected,
      actualStatus: result.status,
      assertionCount: result.assertionCount,
      assertionFailures: result.failures,
      collectionErrors: [...result.collectionErrors, ...pageErrors],
      shots: result.shots,
      recovered: result.recovered,
      fixedStepCadencesHz: result.fixedStepCadencesHz,
    });
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ passed: !failed, summaries }, null, 2));
process.exit(failed ? 1 : 0);
