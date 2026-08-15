/**
 * Topology fingerprint + segment/AABB sightline math for the mission arenas.
 *
 * Two jobs, both pure (no `three`, no DOM), so they run identically in Node, in a
 * headless fixture and in the shipped runtime:
 *
 *  1. A structural FINGERPRINT of an `ArenaDefinition` — bounds, collidable
 *     count and id set, surface/material/height histograms, a route-graph
 *     summary and a sightline signature — reduced to comparable primitives.
 *  2. A `compareTopology` that decides, field by field, whether two arenas are
 *     structurally DISTINCT. The committed comparison test uses it to prove RELAY
 *     BLACKOUT is a different level from the cargo bay — different bounds, a
 *     different collidable id set, a different route graph and a different
 *     sightline signature — rather than a recolour of the same boxes.
 *
 * The sightline machinery is a small exact segment-vs-AABB (slab) test, shared by
 * the fingerprint's occlusion signature and by the LOS-policy fixture, so "can A
 * see B?" is answered the same way everywhere.
 */

import type { ArenaDefinition, Solid, Vec3 } from '../../arena.js';

// ── Segment vs axis-aligned box (slab method) ────────────────────────────────

/** True if the segment a→b intersects the AABB [min,max]. */
export function segmentIntersectsAABB(
  a: Vec3,
  b: Vec3,
  min: Vec3,
  max: Vec3,
): boolean {
  let tmin = 0;
  let tmax = 1;
  for (let axis = 0; axis < 3; axis++) {
    const origin = a[axis];
    const dir = b[axis] - a[axis];
    const lo = min[axis];
    const hi = max[axis];
    if (Math.abs(dir) < 1e-12) {
      // Parallel to this slab: reject only if the origin is outside it.
      if (origin < lo || origin > hi) return false;
    } else {
      let t1 = (lo - origin) / dir;
      let t2 = (hi - origin) / dir;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }
  return true;
}

export interface SightlineOptions {
  /** Solid ids to ignore (e.g. an endpoint's own cover). */
  readonly ignoreIds?: readonly string[];
  /** Only test solids that collide (default true). */
  readonly collidableOnly?: boolean;
}

/**
 * True if the eye-to-eye segment a→b is BLOCKED by any qualifying solid. Solids
 * whose top is below both endpoints never block (a horizontal eye ray passes over
 * low crouch cover), which falls out of the slab test naturally.
 */
export function segmentBlocked(
  a: Vec3,
  b: Vec3,
  solids: readonly Solid[],
  options: SightlineOptions = {},
): boolean {
  const ignore = new Set(options.ignoreIds ?? []);
  const collidableOnly = options.collidableOnly ?? true;
  for (const s of solids) {
    if (collidableOnly && !s.collide) continue;
    if (ignore.has(s.id)) continue;
    if (segmentIntersectsAABB(a, b, s.min, s.max)) return true;
  }
  return false;
}

// ── Stable hashing (FNV-1a over a canonical string) ─────────────────────────

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const round = (v: number, d = 3): number => {
  const s = 10 ** d;
  return Math.round(v * s) / s;
};

// ── Fingerprint ──────────────────────────────────────────────────────────────

export interface TopologyBounds {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly size: Vec3;
}

export interface RouteSignature {
  readonly stepCount: number;
  readonly deckTop: number | null;
  readonly deckCentroid: Vec3 | null;
  readonly spawnCount: number;
  readonly spawnCentroids: readonly Vec3[];
  readonly enemySpawn: Vec3;
  readonly objective: Vec3 | null;
  readonly coverCount: number;
}

export interface SightlineSignature {
  /** Grid resolution per edge. */
  readonly k: number;
  /** Eye height the probes are cast at. */
  readonly eyeHeight: number;
  readonly probeCount: number;
  readonly blockedNorthSouth: number;
  readonly blockedEastWest: number;
  readonly blockedTotal: number;
  readonly ratio: number;
  readonly hash: number;
}

export interface TopologyFingerprint {
  readonly bounds: TopologyBounds;
  readonly solidCount: number;
  readonly collidableCount: number;
  readonly collidableIds: readonly string[];
  readonly idSetHash: number;
  readonly surfaceHistogram: Readonly<Record<string, number>>;
  readonly materialHistogram: Readonly<Record<string, number>>;
  readonly heightBands: Readonly<Record<string, number>>;
  readonly route: RouteSignature;
  readonly sightline: SightlineSignature;
}

function collidable(def: ArenaDefinition): Solid[] {
  return def.solids.filter((s) => s.collide);
}

function computeBounds(solids: readonly Solid[]): TopologyBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const s of solids) {
    for (let a = 0; a < 3; a++) {
      if (s.min[a] < min[a]) min[a] = s.min[a];
      if (s.max[a] > max[a]) max[a] = s.max[a];
    }
  }
  return {
    min: [round(min[0]), round(min[1]), round(min[2])],
    max: [round(max[0]), round(max[1]), round(max[2])],
    size: [round(max[0] - min[0]), round(max[1] - min[1]), round(max[2] - min[2])],
  };
}

function histogram(keys: readonly string[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const k of keys) h[k] = (h[k] ?? 0) + 1;
  return h;
}

/** Height band label for a solid's vertical extent, in coarse metre buckets. */
function heightBand(solid: Solid): string {
  const h = solid.max[1] - solid.min[1];
  if (h < 0.5) return 'flat';
  if (h < 1.25) return 'low';
  if (h < 1.75) return 'mid';
  if (h < 2.75) return 'tall';
  return 'wall';
}

function centroid(solid: Solid): Vec3 {
  return [
    round((solid.min[0] + solid.max[0]) / 2),
    round((solid.min[1] + solid.max[1]) / 2),
    round((solid.min[2] + solid.max[2]) / 2),
  ];
}

function routeSignature(def: ArenaDefinition): RouteSignature {
  const solids = def.solids;
  const steps = solids.filter((s) => s.id.startsWith('step-'));
  const deck = solids.find((s) => s.id === 'deck' || s.id.startsWith('deck-'));
  const spawns = readSpawns(def);
  const objective = readObjective(def);
  return {
    stepCount: steps.length,
    deckTop: deck ? round(deck.max[1]) : null,
    deckCentroid: deck ? centroid(deck) : null,
    spawnCount: spawns.length,
    spawnCentroids: spawns.map((p) => [round(p[0]), round(p[1]), round(p[2])] as Vec3),
    enemySpawn: [round(def.enemySpawn[0]), round(def.enemySpawn[1]), round(def.enemySpawn[2])],
    objective: objective
      ? [round(objective[0]), round(objective[1]), round(objective[2])]
      : null,
    coverCount: def.enemyCoverIds.length,
  };
}

/** Reads the two co-op spawns when present (relay), else the single spawn. */
function readSpawns(def: ArenaDefinition): Vec3[] {
  const withSpawns = def as ArenaDefinition & {
    playerSpawns?: readonly { readonly position: Vec3 }[];
  };
  if (Array.isArray(withSpawns.playerSpawns) && withSpawns.playerSpawns.length > 0) {
    return withSpawns.playerSpawns.map((s) => s.position);
  }
  return [def.playerSpawn];
}

function readObjective(def: ArenaDefinition): Vec3 | null {
  const withObjective = def as ArenaDefinition & {
    objective?: { readonly position: Vec3 };
  };
  return withObjective.objective?.position ?? null;
}

/**
 * A deterministic, bounds-relative occlusion signature: cast a K×K grid of
 * horizontal eye-height probes north↔south and east↔west across the interior and
 * count how many are blocked by collidable geometry. Because the endpoints are
 * sampled relative to each arena's own bounds, the count and bitmask hash reflect
 * the occluder LAYOUT, so two arenas with different cover produce different
 * signatures rather than coincidentally matching.
 */
function sightlineSignature(def: ArenaDefinition, k = 7, eyeHeight = 1.66): SightlineSignature {
  const solids = collidable(def);
  const bounds = computeBounds(solids);
  const inset = 1.0;
  const minX = bounds.min[0] + inset;
  const maxX = bounds.max[0] - inset;
  const minZ = bounds.min[2] + inset;
  const maxZ = bounds.max[2] - inset;
  const lerp = (lo: number, hi: number, t: number): number => lo + (hi - lo) * t;

  const bits: string[] = [];
  let blockedNS = 0;
  let blockedEW = 0;

  // North↔south probes: every south sample to every north sample.
  for (let i = 0; i < k; i++) {
    const xs = lerp(minX, maxX, k === 1 ? 0.5 : i / (k - 1));
    for (let j = 0; j < k; j++) {
      const xn = lerp(minX, maxX, k === 1 ? 0.5 : j / (k - 1));
      const a: Vec3 = [xs, eyeHeight, maxZ];
      const b: Vec3 = [xn, eyeHeight, minZ];
      const blocked = segmentBlocked(a, b, solids);
      if (blocked) blockedNS++;
      bits.push(blocked ? '1' : '0');
    }
  }
  // East↔west probes: every west sample to every east sample.
  for (let i = 0; i < k; i++) {
    const zw = lerp(minZ, maxZ, k === 1 ? 0.5 : i / (k - 1));
    for (let j = 0; j < k; j++) {
      const ze = lerp(minZ, maxZ, k === 1 ? 0.5 : j / (k - 1));
      const a: Vec3 = [minX, eyeHeight, zw];
      const b: Vec3 = [maxX, eyeHeight, ze];
      const blocked = segmentBlocked(a, b, solids);
      if (blocked) blockedEW++;
      bits.push(blocked ? '1' : '0');
    }
  }

  const probeCount = k * k * 2;
  return {
    k,
    eyeHeight,
    probeCount,
    blockedNorthSouth: blockedNS,
    blockedEastWest: blockedEW,
    blockedTotal: blockedNS + blockedEW,
    ratio: round((blockedNS + blockedEW) / probeCount, 4),
    hash: fnv1a(bits.join('')),
  };
}

export function computeTopologyFingerprint(def: ArenaDefinition): TopologyFingerprint {
  const solids = collidable(def);
  const ids = solids.map((s) => s.id).sort();
  return {
    bounds: computeBounds(solids),
    solidCount: def.solids.length,
    collidableCount: solids.length,
    collidableIds: ids,
    idSetHash: fnv1a(ids.join('|')),
    surfaceHistogram: histogram(solids.map((s) => s.surface)),
    materialHistogram: histogram(solids.map((s) => s.material)),
    heightBands: histogram(solids.map(heightBand)),
    route: routeSignature(def),
    sightline: sightlineSignature(def),
  };
}

// ── Comparison ───────────────────────────────────────────────────────────────

export interface TopologyComparison {
  readonly boundsDiffer: boolean;
  readonly collidableCountDiffer: boolean;
  readonly idSetDiffer: boolean;
  readonly sharedIdCount: number;
  /** Collidable ids present in A but not B (structure unique to the first arena). */
  readonly uniqueToA: number;
  /** Collidable ids present in B but not A (structure unique to the second arena). */
  readonly uniqueToB: number;
  readonly surfaceHistogramDiffer: boolean;
  readonly routeDiffer: boolean;
  readonly sightlineDiffer: boolean;
  /** The distinctness axes the task requires: bounds, id set, route, sightline. */
  readonly requiredAxesDistinct: boolean;
  readonly distinct: boolean;
}

function vecEq(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function compareTopology(
  a: TopologyFingerprint,
  b: TopologyFingerprint,
): TopologyComparison {
  const boundsDiffer = !vecEq(a.bounds.min, b.bounds.min)
    || !vecEq(a.bounds.max, b.bounds.max)
    || !vecEq(a.bounds.size, b.bounds.size);

  const setA = new Set(a.collidableIds);
  const setB = new Set(b.collidableIds);
  const shared = b.collidableIds.filter((id) => setA.has(id));
  const uniqueToA = a.collidableIds.filter((id) => !setB.has(id)).length;
  const uniqueToB = b.collidableIds.filter((id) => !setA.has(id)).length;
  const idSetDiffer = a.idSetHash !== b.idSetHash;

  const surfaceHistogramDiffer =
    JSON.stringify(a.surfaceHistogram) !== JSON.stringify(b.surfaceHistogram);

  const routeDiffer = JSON.stringify(a.route) !== JSON.stringify(b.route);
  const sightlineDiffer = a.sightline.hash !== b.sightline.hash
    || a.sightline.blockedTotal !== b.sightline.blockedTotal;

  const requiredAxesDistinct = boundsDiffer && idSetDiffer && routeDiffer && sightlineDiffer;

  return {
    boundsDiffer,
    collidableCountDiffer: a.collidableCount !== b.collidableCount,
    idSetDiffer,
    sharedIdCount: shared.length,
    uniqueToA,
    uniqueToB,
    surfaceHistogramDiffer,
    routeDiffer,
    sightlineDiffer,
    requiredAxesDistinct,
    distinct: requiredAxesDistinct,
  };
}
