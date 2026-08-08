import { runEvidenceSuite } from './suite.js';

const report = runEvidenceSuite();
const output = document.querySelector<HTMLElement>('[data-evidence-output]');
if (output) output.textContent = JSON.stringify(report, null, 2);

Object.assign(window as unknown as Record<string, unknown>, {
  __AI_EVIDENCE__: report,
  __AI_EVIDENCE_READY__: true,
});
