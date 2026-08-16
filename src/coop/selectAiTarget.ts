export interface CoopTargetPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CoopTargetCandidate {
  readonly id: string;
  readonly position: CoopTargetPoint;
  readonly alive: boolean;
  readonly active: boolean;
}

export interface CoopTargetSelection {
  readonly candidate: CoopTargetCandidate;
  readonly visible: boolean;
}

/**
 * Select the nearest visible living player. If no living player is currently
 * visible, return the nearest living player so the existing AI can retain/search
 * last-known contact. Distance ties are stable by player id.
 */
export function selectNearestVisibleTarget(
  enemy: CoopTargetPoint,
  candidates: readonly CoopTargetCandidate[],
  isVisible: (candidate: CoopTargetCandidate) => boolean,
): CoopTargetSelection | null {
  const living = candidates.filter((candidate) => (
    candidate.active
    && candidate.alive
    && finitePoint(candidate.position)
  ));
  if (living.length === 0) return null;
  const visible = living.filter(isVisible);
  const pool = visible.length > 0 ? visible : living;
  const ordered = [...pool].sort((a, b) => {
    const distance = distanceSquared(enemy, a.position) - distanceSquared(enemy, b.position);
    return distance || a.id.localeCompare(b.id);
  });
  return {
    candidate: ordered[0],
    visible: visible.length > 0,
  };
}

function finitePoint(point: CoopTargetPoint): boolean {
  return Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && Number.isFinite(point.z);
}

function distanceSquared(a: CoopTargetPoint, b: CoopTargetPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
