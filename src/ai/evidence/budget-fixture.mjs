import { assertWithinFrameBudget } from './budget-verdict.mjs';

const pairedP95Ms = Number(process.argv[2]);
const budgetMs = Number(process.argv[3]);
const verdict = assertWithinFrameBudget(pairedP95Ms, budgetMs);
console.log(JSON.stringify(verdict));
