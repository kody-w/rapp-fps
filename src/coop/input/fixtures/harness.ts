/**
 * Browser front-end for the co-op gamepad input proof.
 *
 * Runs the IDENTICAL `runIsolationSuite()` the Node runner executes — the seams
 * are pure JavaScript, so the suite needs no real gamepad — and renders the
 * result to the page. Exposes `window.__COOP_INPUT_RESULT__` and
 * `window.__COOP_INPUT_READY__` so a headless driver (Playwright) can read the
 * same report the Node runner archives, proving the logic holds in both
 * environments.
 */

import { runIsolationSuite } from './two-slot-isolation.js';

const report = runIsolationSuite();

const root = document.createElement('main');
root.style.cssText = 'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dfe7ea;'
  + 'background:#0a0d0f;min-height:100vh;margin:0;padding:24px;box-sizing:border-box';

const heading = document.createElement('h1');
heading.style.cssText = 'font-size:16px;margin:0 0 4px';
heading.textContent = 'co-op gamepad input — two-slot isolation proof';
root.appendChild(heading);

const summary = document.createElement('p');
summary.style.cssText = `margin:0 0 16px;font-weight:600;color:${report.ok ? '#6fe39a' : '#ff6b6b'}`;
summary.textContent = `${report.ok ? 'PASS' : 'FAIL'} — ${report.passed}/${report.total} checks`;
root.appendChild(summary);

const categories = [...new Set(report.checks.map((c) => c.category))];
for (const category of categories) {
  const rows = report.checks.filter((c) => c.category === category);
  const bad = rows.filter((c) => !c.pass).length;

  const section = document.createElement('section');
  section.style.cssText = 'margin:0 0 12px';

  const title = document.createElement('div');
  title.style.cssText = 'color:#9fb3bd;margin-bottom:2px';
  title.textContent = `${category}  (${rows.length - bad}/${rows.length})`;
  section.appendChild(title);

  for (const row of rows) {
    const item = document.createElement('div');
    item.style.color = row.pass ? '#8fb98f' : '#ff6b6b';
    item.textContent = `${row.pass ? 'ok ' : 'BAD'}  ${row.name}${row.pass ? '' : `  — ${row.detail}`}`;
    section.appendChild(item);
  }
  root.appendChild(section);
}

document.body.style.margin = '0';
document.body.appendChild(root);

Object.assign(window as unknown as Record<string, unknown>, {
  __COOP_INPUT_RESULT__: report,
  __COOP_INPUT_READY__: true,
});
