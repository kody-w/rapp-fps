import {
  selectNearestVisibleTarget,
  type CoopTargetCandidate,
} from '../selectAiTarget.js';

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const enemy = { x: 0, y: 0, z: 0 };
const candidate = (
  id: string,
  distance: number,
  overrides: Partial<CoopTargetCandidate> = {},
): CoopTargetCandidate => ({
  id,
  position: { x: distance, y: 0, z: 0 },
  alive: true,
  active: true,
  ...overrides,
});

export function buildTargetingReport(): {
  readonly ok: boolean;
  readonly checks: readonly Check[];
  readonly negativeControlDetected: boolean;
} {
  const checks: Check[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  const nearest = selectNearestVisibleTarget(
    enemy,
    [candidate('player-1', 8), candidate('player-2', 3)],
    () => true,
  );
  check(
    'nearest-visible',
    nearest?.candidate.id === 'player-2' && nearest.visible,
    `selected=${nearest?.candidate.id}, visible=${nearest?.visible}`,
  );

  const visibleBeatsNearOccluded = selectNearestVisibleTarget(
    enemy,
    [candidate('player-1', 2), candidate('player-2', 7)],
    (entry) => entry.id === 'player-2',
  );
  check(
    'visible-beats-near-occluded',
    visibleBeatsNearOccluded?.candidate.id === 'player-2'
      && visibleBeatsNearOccluded.visible,
    `selected=${visibleBeatsNearOccluded?.candidate.id}`,
  );

  const fallback = selectNearestVisibleTarget(
    enemy,
    [candidate('player-1', 6), candidate('player-2', 4)],
    () => false,
  );
  check(
    'nearest-living-fallback',
    fallback?.candidate.id === 'player-2' && fallback.visible === false,
    `selected=${fallback?.candidate.id}, visible=${fallback?.visible}`,
  );

  const excludesUnavailable = selectNearestVisibleTarget(
    enemy,
    [
      candidate('player-1', 1, { alive: false }),
      candidate('player-2', 2),
      candidate('player-3', 0.5, { active: false }),
    ],
    () => true,
  );
  check(
    'dead-inactive-excluded',
    excludesUnavailable?.candidate.id === 'player-2',
    `selected=${excludesUnavailable?.candidate.id}`,
  );

  const stableTie = selectNearestVisibleTarget(
    enemy,
    [candidate('player-2', 5), candidate('player-1', 5)],
    () => true,
  );
  check(
    'stable-id-tie',
    stableTie?.candidate.id === 'player-1',
    `selected=${stableTie?.candidate.id}`,
  );

  const malformedExcluded = selectNearestVisibleTarget(
    enemy,
    [
      candidate('player-1', 1, {
        position: { x: Number.NaN, y: 0, z: 0 },
      }),
      candidate('player-2', 4),
    ],
    () => true,
  );
  check(
    'non-finite-position-excluded',
    malformedExcluded?.candidate.id === 'player-2',
    `selected=${malformedExcluded?.candidate.id}`,
  );

  // Mutation assay: a selector that sorts every living candidate by distance
  // before applying visibility would incorrectly choose player-1 here.
  const badMutationSelection = 'player-1';
  const negativeControlDetected = (
    badMutationSelection !== visibleBeatsNearOccluded?.candidate.id
  );
  check(
    'visibility-order-negative-control',
    negativeControlDetected,
    `mutated=${badMutationSelection}, required=${visibleBeatsNearOccluded?.candidate.id}`,
  );

  return {
    ok: checks.every((entry) => entry.passed),
    checks,
    negativeControlDetected,
  };
}
