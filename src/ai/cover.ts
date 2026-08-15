/**
 * Cover reasoning.
 *
 * Candidates are stances generated at the faces of the arena's boxes. Each is
 * scored on three axes and the lowest score wins:
 *
 *  - exposure: is the threat's eye line to this stance blocked by geometry?
 *    A stance in a box's shadow scores 0 (protected); an open one scores 1.
 *    This is the whole point — the enemy ends up behind a box, not beside it.
 *  - path cost: how far the enemy must travel to reach it. Near cover beats far.
 *  - flank: how far the stance sits off the current engagement line. Rewarding
 *    a change of angle is what stops repositioning from shuffling in place.
 *
 * Selection runs only on a state change or a reposition decision, never every
 * tick, so the modest allocation here is off the hot path.
 */

import type { EnemyConfig, StaticWorld, Vec3 } from './types.js';
import type { ArenaCover } from './world.js';
import { lineOfSightClear } from './world.js';
import { SeededRandom } from './random.js';
import { clamp } from './math.js';

export interface CoverCandidate {
  id: string;
  boxId: string;
  position: Vec3;
  exposure: number;
  pathCost: number;
  flank: number;
  score: number;
}

interface FaceOffset {
  suffix: string;
  ox: number;
  oz: number;
}

const FACES: readonly FaceOffset[] = [
  { suffix: '+z', ox: 0, oz: 1 },
  { suffix: '-z', ox: 0, oz: -1 },
  { suffix: '+x', ox: 1, oz: 0 },
  { suffix: '-x', ox: -1, oz: 0 },
];

export interface CoverQuery {
  world: StaticWorld;
  cover: readonly ArenaCover[];
  agent: Vec3;
  threat: Vec3;
  config: EnemyConfig;
  rng: SeededRandom;
  /** Skip stances belonging to this box (used to force a genuine move). */
  excludeBoxId?: string;
  halfExtent: number;
}

/**
 * Perpendicular distance of `p` from the infinite line through `a` in direction
 * `dir` (dir need not be unit; guarded). Used as the flank measure.
 */
function lateralOffset(px: number, pz: number, ax: number, az: number, dx: number, dz: number): number {
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;
  // Reject the component along the line, keep the perpendicular magnitude.
  const rx = px - ax;
  const rz = pz - az;
  const along = rx * nx + rz * nz;
  const perpX = rx - along * nx;
  const perpZ = rz - along * nz;
  return Math.hypot(perpX, perpZ);
}

/**
 * Builds and scores every candidate. Returned sorted best-first. Exposed for
 * the cover fixture; the agent uses `selectCover` which returns just the best.
 */
export function rankCover(query: CoverQuery): CoverCandidate[] {
  const { world, cover, agent, threat, config, rng, excludeBoxId, halfExtent } = query;
  const candidates: CoverCandidate[] = [];

  const dirX = threat.x - agent.x;
  const dirZ = threat.z - agent.z;

  for (const box of cover) {
    if (excludeBoxId !== undefined && box.id === excludeBoxId) continue;
    for (const face of FACES) {
      const px = box.center.x + face.ox * (box.half.x + config.coverStandOff);
      const pz = box.center.z + face.oz * (box.half.z + config.coverStandOff);

      // Stay inside the arena.
      if (Math.abs(px) > halfExtent || Math.abs(pz) > halfExtent) continue;

      // Never take cover on top of the threat.
      const toThreat = Math.hypot(threat.x - px, threat.z - pz);
      if (toThreat < config.coverMinThreatSeparation) continue;

      // Exposure: can the threat's eye line reach a low head at this stance?
      const headX = px;
      const headY = config.coverStanceHeight;
      const headZ = pz;
      const threatEye = { x: threat.x, y: config.eyeHeight, z: threat.z };
      const stanceHead = { x: headX, y: headY, z: headZ };
      const exposed = lineOfSightClear(world, threatEye, stanceHead) ? 1 : 0;

      const pathCost = clamp(
        Math.hypot(px - agent.x, pz - agent.z) / config.coverPathNormalize,
        0,
        1,
      );
      const flankRaw = lateralOffset(px, pz, agent.x, agent.z, dirX, dirZ);
      const flank = clamp(flankRaw / 4, 0, 1);

      // Lower is better. A deterministic tie-break keeps repeated runs stable
      // while still varying stance choice from seed to seed.
      const noise = rng.next() * config.coverWeightExposure * 0.001;
      const score =
        config.coverWeightExposure * exposed +
        config.coverWeightPath * pathCost +
        config.coverWeightFlank * (1 - flank) +
        noise;

      candidates.push({
        id: `${box.id}:${face.suffix}`,
        boxId: box.id,
        position: { x: px, y: 0, z: pz },
        exposure: exposed,
        pathCost,
        flank,
        score,
      });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates;
}

export function selectCover(query: CoverQuery): CoverCandidate | null {
  const ranked = rankCover(query);
  return ranked.length > 0 ? ranked[0] : null;
}
