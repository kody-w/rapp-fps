/**
 * Renderer-free anchor + resource-ceiling fixture for the DUSKLINE A7 art
 * (Refs #59). The muzzle and ejection anchors are gameplay-critical: hitscan and
 * shell ejection read their world positions, so the finished art must keep them
 * physically on the geometry a player sees. This harness proves, in the same
 * THREE build the game uses, that:
 *
 *   1. The muzzle anchor is strictly *inside* the shipped barrel/muzzle cluster
 *      (odd ray-parity in every axis direction) and within 3 mm of its surface.
 *   2. The ejection anchor sits *on* the shipped ejection-port cluster (within
 *      3 mm of its surface) and inside the port's y/z footprint.
 *   3. The whole rifle stays under the triangle ceiling for a camera-local
 *      weapon, and renders as exactly three merged material groups.
 *
 * The clusters come from the same builders the rifle ships (buildMuzzle.../
 * addEjectionPort via the *ForProof exports), so proving the anchors here proves
 * them for the shipped weapon. Nothing here touches a renderer or a Material.
 */

import * as THREE from 'three';
import {
  buildDusklineRifle,
  buildMuzzleClusterForProof,
  buildEjectionClusterForProof,
  MUZZLE_ANCHOR,
  EJECTION_ANCHOR,
} from '../RifleGeometry.js';

/** A camera-local weapon: a few thousand triangles is fine, tens of thousands is not. */
const TRIANGLE_CEILING = 9000;
/** An anchor is "on" a surface if the nearest triangle is within this distance. */
const SURFACE_TOLERANCE_M = 0.003;
/** The six axis probe directions used for inside/outside ray parity. */
const AXES: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: Record<string, unknown>;
}

interface AnchorResult {
  status: 'passed' | 'failed';
  pass: boolean;
  triangleCeiling: number;
  surfaceToleranceM: number;
  checks: Check[];
}

/** Shortest distance from a point to any triangle of a (possibly indexed) geometry. */
function nearestSurfaceDistance(geometry: THREE.BufferGeometry, point: THREE.Vector3): number {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const triCount = index ? index.count / 3 : position.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const triangle = new THREE.Triangle();
  let min = Infinity;
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    triangle.set(a, b, c);
    triangle.closestPointToPoint(point, closest);
    const d = closest.distanceTo(point);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Count ray crossings from `point` along every axis. A point inside a closed mesh
 * crosses the boundary an odd number of times in every direction; a point outside
 * crosses an even number. DoubleSide is required so the exit face is not culled
 * when the ray originates inside the solid.
 */
function rayParity(geometry: THREE.BufferGeometry, point: THREE.Vector3): {
  insideVotes: number; total: number; crossings: number[];
} {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  mesh.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.far = Infinity;
  const crossings: number[] = [];
  let insideVotes = 0;
  for (const dir of AXES) {
    raycaster.set(point, dir.clone().normalize());
    const hits = raycaster.intersectObject(mesh, false);
    crossings.push(hits.length);
    if (hits.length % 2 === 1) insideVotes++;
  }
  return { insideVotes, total: AXES.length, crossings };
}

function run(): AnchorResult {
  const checks: Check[] = [];

  // 1. Resource ceiling + three merged material groups.
  const rifle = buildDusklineRifle();
  const triOf = (g: THREE.BufferGeometry): number => {
    const p = g.getAttribute('position');
    return (g.index ? g.index.count : p.count) / 3;
  };
  const metalTris = triOf(rifle.metal);
  const polymerTris = triOf(rifle.polymer);
  const accentTris = triOf(rifle.accent);
  const totalTris = metalTris + polymerTris + accentTris;
  checks.push({
    name: 'triangle-ceiling',
    pass: totalTris === rifle.triangleCount && totalTris <= TRIANGLE_CEILING,
    detail: {
      totalTris, reported: rifle.triangleCount, ceiling: TRIANGLE_CEILING,
      groups: { metalTris, polymerTris, accentTris },
    },
  });
  const groupsPresent = !!rifle.metal && !!rifle.polymer && !!rifle.accent;
  const allHaveColor = [rifle.metal, rifle.polymer, rifle.accent]
    .every((g) => !!g.getAttribute('color'));
  checks.push({
    name: 'three-material-groups',
    pass: groupsPresent && allHaveColor,
    detail: {
      groups: ['metal', 'polymer', 'accent'],
      allHaveVertexColor: allHaveColor,
      note: 'one merged BufferGeometry per group => three draw calls',
    },
  });
  rifle.metal.dispose();
  rifle.polymer.dispose();
  rifle.accent.dispose();

  // 2. Muzzle anchor strictly inside its cluster and on its surface.
  const muzzle = buildMuzzleClusterForProof();
  const muzzleParity = rayParity(muzzle, MUZZLE_ANCHOR);
  const muzzleDistance = nearestSurfaceDistance(muzzle, MUZZLE_ANCHOR);
  checks.push({
    name: 'muzzle-anchor-inside-cluster',
    pass: muzzleParity.insideVotes === muzzleParity.total
      && muzzleDistance <= SURFACE_TOLERANCE_M,
    detail: {
      anchor: MUZZLE_ANCHOR.toArray(),
      insideVotes: `${muzzleParity.insideVotes}/${muzzleParity.total}`,
      axisCrossings: muzzleParity.crossings,
      nearestSurfaceMm: Number((muzzleDistance * 1000).toFixed(3)),
      toleranceMm: SURFACE_TOLERANCE_M * 1000,
    },
  });
  muzzle.dispose();

  // 3. Ejection anchor on the port cluster surface and inside its footprint.
  const ejection = buildEjectionClusterForProof();
  ejection.computeBoundingBox();
  const box = ejection.boundingBox!;
  const ejectionDistance = nearestSurfaceDistance(ejection, EJECTION_ANCHOR);
  const pad = SURFACE_TOLERANCE_M;
  const inFootprint =
    EJECTION_ANCHOR.y >= box.min.y - pad && EJECTION_ANCHOR.y <= box.max.y + pad &&
    EJECTION_ANCHOR.z >= box.min.z - pad && EJECTION_ANCHOR.z <= box.max.z + pad &&
    EJECTION_ANCHOR.x >= box.min.x - pad && EJECTION_ANCHOR.x <= box.max.x + pad;
  checks.push({
    name: 'ejection-anchor-on-port',
    pass: ejectionDistance <= SURFACE_TOLERANCE_M && inFootprint,
    detail: {
      anchor: EJECTION_ANCHOR.toArray(),
      nearestSurfaceMm: Number((ejectionDistance * 1000).toFixed(3)),
      toleranceMm: SURFACE_TOLERANCE_M * 1000,
      insidePortFootprint: inFootprint,
      clusterBox: { min: box.min.toArray(), max: box.max.toArray() },
    },
  });
  ejection.dispose();

  const pass = checks.every((c) => c.pass);
  return {
    status: pass ? 'passed' : 'failed',
    pass,
    triangleCeiling: TRIANGLE_CEILING,
    surfaceToleranceM: SURFACE_TOLERANCE_M,
    checks,
  };
}

const result = run();
(window as unknown as { __ANCHOR_RESULT__: AnchorResult }).__ANCHOR_RESULT__ = result;
const pre = document.getElementById('result');
if (pre) pre.textContent = JSON.stringify(result, null, 2);
// eslint-disable-next-line no-console
console.log('[anchor]', JSON.stringify(result));
