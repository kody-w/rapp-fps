import { clamp } from './math.js';
import type { CoverWeights } from './types.js';

export interface CoverScoreInput {
  exposure: number;
  pathCost: number;
  flank: number;
}

export function scoreCoverCandidate(
  input: CoverScoreInput,
  weights: CoverWeights,
  pathCostNormalization: number,
): number {
  const exposureScore = 1 - clamp(input.exposure, 0, 1);
  const pathScore = 1 - clamp(input.pathCost / Math.max(pathCostNormalization, 1e-6), 0, 1);
  const flankScore = clamp(input.flank, 0, 1);
  return (
    exposureScore * weights.exposure
    + pathScore * weights.pathCost
    + flankScore * weights.flank
  );
}
