/**
 * RELAY BLACKOUT — topology / LOS / clearance fixture (issue #72, parent #70).
 *
 * The correspondence proof shows render == collision, and the traversal fixture
 * shows a player can walk the route, but neither says the mission is a DIFFERENT
 * level from the cargo bay, that its two deploy pads actually fit a capsule, or
 * that the enemy/player initial sightlines are the ones the design intends rather
 * than an accident of where boxes landed. This fixture answers those three, all
 * against the SHIPPING data and the SHIPPING capsule solver:
 *
 *   1. DISTINCT — `computeTopologyFingerprint` for RELAY BLACKOUT vs the cargo
 *      bay (`buildArena`), compared by `compareTopology`. Asserts the four
 *      required axes differ: bounds, collidable id set, route graph, sightline
 *      signature. A recolour of cargo would fail here.
 *   2. BUDGET + CLEARANCE — collidable box count ≤ 45; each of the two co-op
 *      deploy pads fits a STANDING capsule (`StaticBoxWorld.canFit`, the shipping
 *      solver), rests on the floor (feet y=0), lies inside the play bounds, and
 *      is not inside any solid.
 *   3. LOS POLICY — the declared `los.expect` is MEASURED with the shared
 *      segment/AABB test at the real player eye height (asserted equal to
 *      `DEFAULT_PLAYER_TUNING.standingEyeHeight`): enemy↔both pads blocked, pads
 *      mutually clear, objective screened from both pads, enemy sighted on the
 *      objective it defends. A leak flips an assertion.
 *
 * Published on `window.__RELAY_TOPOLOGY__` for the playwright runner. Binds only
 * `src/level` + the shipping `src/player` capsule test — both present in an
 * integrated tree. It is a `.mjs` on purpose so it stays out of `tsc` while still
 * importing the real `.ts` modules (vite transforms them).
 */

import * as THREE from 'three';
import { buildRelayArena } from '../relayArena.js';
import { buildArena } from '../../../arena.js';
import { buildStaticWorld, collidableSolids } from '../../../staticWorld.js';
import { computeTopologyFingerprint, compareTopology, segmentBlocked } from '../topology.js';
import { StaticBoxWorld } from '../../../../player/StaticBoxWorld.js';
import { DEFAULT_PLAYER_TUNING } from '../../../../player/config.js';

const out = window;
const MAX_COLLIDABLE = 45;

const round = (v, d = 4) => {
  const s = 10 ** d;
  return Math.round(v * s) / s;
};

/** True if the point lies strictly inside any collidable solid. */
function insideAnySolid(p, solids) {
  for (const s of solids) {
    if (
      p[0] > s.min[0] && p[0] < s.max[0]
      && p[1] > s.min[1] && p[1] < s.max[1]
      && p[2] > s.min[2] && p[2] < s.max[2]
    ) return s.id;
  }
  return null;
}

try {
  const def = buildRelayArena();
  const cargo = buildArena();
  const world = buildStaticWorld(def);
  const solver = StaticBoxWorld.fromStaticWorld(world);
  const tuning = DEFAULT_PLAYER_TUNING;
  const solids = collidableSolids(def);

  // ── 1. Distinct from cargo ────────────────────────────────────────────────
  const relayFp = computeTopologyFingerprint(def);
  const cargoFp = computeTopologyFingerprint(cargo);
  const cmp = compareTopology(relayFp, cargoFp);

  // ── 2. Budget + spawn clearance/bounds ────────────────────────────────────
  const bounds = world.bounds;
  const spawns = def.playerSpawns.map((slot) => {
    const p = slot.position;
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    const fits = solver.canFit(v, tuning.standingHeight, tuning.radius);
    const inBounds = p[0] > bounds.min[0] + tuning.radius && p[0] < bounds.max[0] - tuning.radius
      && p[2] > bounds.min[2] + tuning.radius && p[2] < bounds.max[2] - tuning.radius;
    const onFloor = Math.abs(p[1]) < 1e-6;
    const inside = insideAnySolid(p, solids);
    return { name: slot.name, position: p, fits, inBounds, onFloor, insideSolid: inside };
  });
  const enemyInside = insideAnySolid(def.enemySpawn, solids);
  const enemyFits = solver.canFit(
    new THREE.Vector3(def.enemySpawn[0], def.enemySpawn[1], def.enemySpawn[2]),
    tuning.standingHeight,
    tuning.radius,
  );

  // ── 3. LOS policy, measured at the real eye height ────────────────────────
  const eye = def.los.eyeHeight;
  const feetEye = (p) => [p[0], p[1] + eye, p[2]];
  const enemy = feetEye(def.enemySpawn);
  const spawnA = feetEye(def.playerSpawns[0].position);
  const spawnB = feetEye(def.playerSpawns[1].position);
  const objective = feetEye(def.objective.position); // deck feet (1.6) + eye
  // Ignore the relay cabinet when probing the hold spot it sits behind, so we
  // measure visibility of the standing point rather than of its own cover.
  const objIgnore = { ignoreIds: [def.objective.id] };

  const measure = (a, b, opts) => (segmentBlocked(a, b, solids, opts) ? 'blocked' : 'clear');
  const los = {
    enemyToSpawnA: measure(enemy, spawnA),
    enemyToSpawnB: measure(enemy, spawnB),
    spawnAToSpawnB: measure(spawnA, spawnB),
    spawnAToObjective: measure(spawnA, objective, objIgnore),
    spawnBToObjective: measure(spawnB, objective, objIgnore),
    enemyToObjective: measure(enemy, objective, objIgnore),
  };

  // ── Assertions ────────────────────────────────────────────────────────────
  const assertions = [];
  const add = (name, passed, actual, expected) =>
    assertions.push({ name, passed, actual, expected });

  add('distinct_bounds', cmp.boundsDiffer,
    { relay: relayFp.bounds.size, cargo: cargoFp.bounds.size },
    'relay and cargo collidable bounds differ');
  add('distinct_id_set',
    cmp.idSetDiffer && cmp.uniqueToA >= 12 && cmp.uniqueToB >= 12,
    { idSetDiffer: cmp.idSetDiffer, sharedIdCount: cmp.sharedIdCount,
      uniqueToRelay: cmp.uniqueToA, uniqueToCargo: cmp.uniqueToB },
    'different id-set hash with many collidable ids unique to each arena '
      + '(the shared handful are the reused shell vocabulary: floor/wall/deck/step/parapet)');
  add('distinct_route_graph', cmp.routeDiffer,
    { relay: relayFp.route, cargo: cargoFp.route },
    'route signatures differ (deck centroid / spawn count / objective / steps)');
  add('distinct_sightline', cmp.sightlineDiffer,
    { relay: relayFp.sightline, cargo: cargoFp.sightline },
    'sightline signature (blocked count / bitmask hash) differs');
  add('required_axes_distinct', cmp.requiredAxesDistinct,
    { requiredAxesDistinct: cmp.requiredAxesDistinct },
    'bounds AND id set AND route AND sightline all distinct');

  add('collidable_within_ceiling', relayFp.collidableCount <= MAX_COLLIDABLE,
    { collidableCount: relayFp.collidableCount, ceiling: MAX_COLLIDABLE },
    `≤ ${MAX_COLLIDABLE} collidable boxes`);

  add('two_distinct_spawns',
    def.playerSpawns.length === 2
      && (def.playerSpawns[0].position[0] !== def.playerSpawns[1].position[0]
        || def.playerSpawns[0].position[2] !== def.playerSpawns[1].position[2]),
    { spawns: def.playerSpawns.map((s) => s.position) },
    'exactly two distinct co-op deploy pads');

  add('spawns_fit_capsule', spawns.every((s) => s.fits),
    { spawns: spawns.map((s) => ({ name: s.name, fits: s.fits })) },
    'each pad fits a standing capsule (shipping StaticBoxWorld.canFit)');
  add('spawns_on_floor_in_bounds',
    spawns.every((s) => s.onFloor && s.inBounds && s.insideSolid === null),
    { spawns },
    'each pad rests on the floor, inside bounds, not inside any solid');
  add('enemy_placement_valid', enemyFits && enemyInside === null,
    { enemyFits, enemyInside, enemySpawn: def.enemySpawn },
    'enemy spawn fits a capsule and is not inside a solid');

  add('cover_ids_collidable_and_enough',
    def.enemyCoverIds.length >= 4
      && def.enemyCoverIds.every((id) => solids.some((s) => s.id === id)),
    { count: def.enemyCoverIds.length, ids: def.enemyCoverIds },
    '≥ 4 authored enemy cover ids, every one collidable');

  add('eye_height_matches_tuning', eye === tuning.standingEyeHeight,
    { losEyeHeight: eye, tuningEyeHeight: tuning.standingEyeHeight },
    'LOS eye height equals DEFAULT_PLAYER_TUNING.standingEyeHeight');

  const expect = def.los.expect;
  const losMatches = Object.keys(expect).every((k) => los[k] === expect[k]);
  add('los_policy_measured_as_declared', losMatches,
    { measured: los, declared: expect },
    'measured enemy/player/objective sightlines match the declared policy');

  const ok = assertions.every((a) => a.passed);

  out.__RELAY_TOPOLOGY__ = {
    at: new Date().toISOString(),
    ok,
    mission: def.mission,
    losPolicy: { name: def.los.name, statement: def.los.statement, eyeHeight: eye },
    losMeasured: los,
    budget: { collidableCount: relayFp.collidableCount, ceiling: MAX_COLLIDABLE, solidCount: relayFp.solidCount },
    bounds: { relay: relayFp.bounds, cargo: cargoFp.bounds },
    comparison: cmp,
    fingerprints: { relay: relayFp, cargo: cargoFp },
    spawns,
    enemy: { spawn: def.enemySpawn, fits: enemyFits, insideSolid: enemyInside },
    world: { boxes: world.boxes.length, bounds: world.bounds },
    tuning: {
      radius: tuning.radius,
      standingHeight: tuning.standingHeight,
      standingEyeHeight: tuning.standingEyeHeight,
    },
    assertions,
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__RELAY_TOPOLOGY_ERROR__ = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  out.__FRAME_READY__ = true;
}
