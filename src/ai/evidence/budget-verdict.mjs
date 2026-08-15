import assert from 'node:assert/strict';

export function frameBudgetVerdict(pairedP95Ms, budgetMs) {
  assert.ok(Number.isFinite(pairedP95Ms), `paired p95 must be finite; received ${pairedP95Ms}`);
  assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, `budget must be positive; received ${budgetMs}`);
  const overBudget = pairedP95Ms > budgetMs;
  return {
    pairedP95Ms,
    budgetMs,
    overBudget,
    verdict: overBudget ? 'FAIL' : 'PASS',
  };
}

export function assertWithinFrameBudget(pairedP95Ms, budgetMs) {
  const result = frameBudgetVerdict(pairedP95Ms, budgetMs);
  assert.equal(
    result.overBudget,
    false,
    `paired p95 ${pairedP95Ms.toFixed(3)} ms exceeds ${budgetMs.toFixed(3)} ms budget`,
  );
  return result;
}
