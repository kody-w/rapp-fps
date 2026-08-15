/**
 * Integration fixtures for hitscan against the shipping arena's static world
 * (issue #32 / #37). Two layers are proven:
 *
 *  1. The analytic AABB collider resolves point, world-space axis normal, box
 *     material, and nearest-of-many correctly, and refuses a malformed world.
 *  2. WeaponSystem.useStaticWorld() routes real hitscan through that collider:
 *     with the arena wired, a round resolves against the validated box and a
 *     cosmetic scene mesh in front of it is transparent (the arena boxes are the
 *     only colliders); with it unwired, the same shot resolves against the scene
 *     mesh. That contrast is the integration.
 *
 * Runs in the browser through Vite; run-staticworld.mjs reads the JSON result.
 */

import * as THREE from 'three';
import { EventBusImpl } from '../../core/bus.js';
import { Events } from '../../core/contracts.js';
import type { EngineContext, InputState, QualityTier } from '../../core/contracts.js';
import type { StaticWorld } from '../../core/collision.js';
import { StaticWorldCollider } from '../StaticWorldCollider.js';
import { WeaponSystem } from '../WeaponSystem.js';
import { DUSKLINE_A7 } from '../WeaponConfig.js';
import type { BulletImpactPayload } from '../events.js';

const FIXED_STEP = 1 / 120;

interface Outcome {
  readonly name: string;
  readonly pass: boolean;
  readonly failures: string[];
  readonly detail: Record<string, unknown>;
}

interface HarnessResult {
  status: 'passed' | 'failed' | 'collection-error';
  collectionErrors: string[];
  tests: Outcome[];
}

function makeInput(): InputState {
  return {
    move: { x: 0, y: 0 }, look: { x: 0, y: 0 },
    jump: false, crouch: false, sprint: false, fire: false, aim: false, reload: false,
    pressed: () => false,
  };
}

function makeContext(scene: THREE.Scene, camera: THREE.PerspectiveCamera, bus: EventBusImpl, input: InputState): EngineContext {
  return {
    scene, camera, renderer: {} as THREE.WebGLRenderer,
    time: 0, input, bus, quality: 'ultra' as QualityTier, get: () => undefined,
  };
}

function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 2000);
  camera.rotation.order = 'YXZ';
  camera.updateMatrixWorld(true);
  return camera;
}

// A single-box arena the camera at the origin looks straight into down −Z.
function arena(material: 'concrete' | 'metal' | 'wood' | 'dirt' = 'metal', nearZ = -19): StaticWorld {
  return {
    boxes: [{ min: [-5, -5, nearZ - 1], max: [5, 5, nearZ], material }],
    bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
  };
}

// ── 1. analytic collider ──────────────────────────────────────────────────────
function testColliderResolvesBox(): Outcome {
  const failures: string[] = [];
  const collider = new StaticWorldCollider(arena('metal', -19));
  const hit = collider.raycast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 400);

  if (!hit) {
    failures.push('ray straight down −Z into the box returned no hit');
    return { name: 'colliderResolvesBox', pass: false, failures, detail: {} };
  }
  // Near face is z = max.z = −19; a −Z ray enters there with an outward +Z normal.
  if (Math.abs(hit.point.z - -19) > 1e-9) failures.push(`impact z ${hit.point.z} != -19`);
  if (Math.abs(hit.distance - 19) > 1e-9) failures.push(`distance ${hit.distance} != 19`);
  const normalErr = hit.normal.angleTo(new THREE.Vector3(0, 0, 1)) * 180 / Math.PI;
  if (normalErr > 1e-6) failures.push(`normal ${hit.normal.toArray()} is ${normalErr.toFixed(6)}° off +Z`);
  if (hit.material !== 'metal') failures.push(`material ${hit.material} != metal`);

  return {
    name: 'colliderResolvesBox',
    pass: failures.length === 0,
    failures,
    detail: { point: hit.point.toArray(), normal: hit.normal.toArray(), distance: hit.distance, material: hit.material },
  };
}

function testColliderNearestMissAndInvalid(): Outcome {
  const failures: string[] = [];
  const detail: Record<string, unknown> = {};

  // Nearest of two boxes wins.
  const world: StaticWorld = {
    boxes: [
      { min: [-2, -2, -30], max: [2, 2, -29], material: 'concrete' },
      { min: [-2, -2, -12], max: [2, 2, -11], material: 'wood' },
    ],
    bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
  };
  const collider = new StaticWorldCollider(world);
  const near = collider.raycast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 400);
  if (!near || near.material !== 'wood' || Math.abs(near.point.z - -11) > 1e-9) {
    failures.push(`nearest hit should be the wood box at z=-11; got ${near ? `${near.material}@${near.point.z}` : 'null'}`);
  }
  detail.nearest = near ? { material: near.material, z: near.point.z } : null;

  // A ray pointing away misses entirely.
  const away = collider.raycast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1), 400);
  if (away !== null) failures.push('ray pointing +Z away from both boxes should miss');
  detail.awayMiss = away === null;

  // A ray parallel to the box faces but outside the slab misses.
  const parallel = collider.raycast(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 0, -1), 400);
  if (parallel !== null) failures.push('ray 100 m above the boxes should miss');
  detail.parallelMiss = parallel === null;

  // A degenerate world is refused rather than silently degraded.
  let refused = false;
  try {
    new StaticWorldCollider({
      boxes: [{ min: [0, 0, 0], max: [0, 1, 1], material: 'metal' }],
      bounds: { min: [-1, -1, -1], max: [2, 2, 2] },
    });
  } catch {
    refused = true;
  }
  if (!refused) failures.push('a zero-thickness box must be refused by assertValidStaticWorld');
  detail.refusedInvalidWorld = refused;

  return { name: 'colliderNearestMissAndInvalid', pass: failures.length === 0, failures, detail };
}

// ── 2. weapon integration ─────────────────────────────────────────────────────
// Fire one shot and return where it lands, with a cosmetic ballistic mesh placed
// in FRONT of the arena box. `useArena` toggles the static-world routing.
function fireOneShot(
  useArena: boolean,
  dynamicZ?: number,
  wallZ = -19,
): { z: number; normalZ: number; material: string; targetId?: string | number } | null {
  const scene = new THREE.Scene();
  // Cosmetic wall at z ≈ −10 (nearer than the arena box at −19). In the scene
  // path this would stop the round; in arena mode it must be transparent.
  const cosmetic = new THREE.Mesh(new THREE.BoxGeometry(30, 30, 0.5), new THREE.MeshBasicMaterial());
  cosmetic.position.set(0, 0, -10);
  cosmetic.userData.ballisticCollider = true;
  cosmetic.userData.surface = 'concrete';
  cosmetic.updateMatrixWorld(true);
  scene.add(cosmetic);
  if (dynamicZ !== undefined) {
    const target = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial(),
    );
    target.position.set(0, 0, dynamicZ);
    target.userData.ballisticCollider = true;
    target.userData.damageTargetId = 'enemy-test';
    target.userData.surface = 'flesh';
    target.updateMatrixWorld(true);
    scene.add(target);
  }

  const camera = makeCamera();
  const bus = new EventBusImpl();
  const input = makeInput();
  const weapon = new WeaponSystem(DUSKLINE_A7);
  const ctx = makeContext(scene, camera, bus, input);
  weapon.init(ctx);
  if (useArena) weapon.useStaticWorld(arena('metal', wallZ));

  let impact: BulletImpactPayload | null = null;
  const off = bus.on<BulletImpactPayload>(Events.BulletImpact, (p) => { if (!impact) impact = p; });

  input.fire = true;
  let guard = 0;
  while (impact === null && guard++ < 200) weapon.fixedUpdate(FIXED_STEP, ctx);
  off();
  weapon.dispose();

  if (impact === null) return null;
  const hit = impact as BulletImpactPayload;
  return {
    z: hit.point.z,
    normalZ: hit.normal.z,
    material: String(hit.material),
    targetId: hit.targetId,
  };
}

function testDynamicTargetAndWorldChooseNearest(): Outcome {
  const failures: string[] = [];

  const targetFirst = fireOneShot(true, -8, -19);
  if (!targetFirst || targetFirst.targetId !== 'enemy-test') {
    failures.push(`dynamic enemy before wall should win; got ${JSON.stringify(targetFirst)}`);
  } else if (targetFirst.material !== 'flesh') {
    failures.push(`dynamic target should report flesh; got ${targetFirst.material}`);
  }

  const wallFirst = fireOneShot(true, -20, -9);
  if (!wallFirst || wallFirst.targetId !== undefined) {
    failures.push(`wall before enemy should occlude target; got ${JSON.stringify(wallFirst)}`);
  } else if (wallFirst.material !== 'metal') {
    failures.push(`occluding wall should report metal; got ${wallFirst.material}`);
  }

  return {
    name: 'dynamicTargetAndWorldChooseNearest',
    pass: failures.length === 0,
    failures,
    detail: { targetFirst, wallFirst },
  };
}

function testWeaponResolvesAgainstArena(): Outcome {
  const failures: string[] = [];

  const scenePath = fireOneShot(false);
  const arenaPath = fireOneShot(true);

  if (!scenePath) failures.push('scene-path shot produced no impact');
  else if (Math.abs(scenePath.z - -9.75) > 0.5) {
    failures.push(`scene-path shot should hit the cosmetic wall near z=-9.75; got z=${scenePath.z}`);
  }

  if (!arenaPath) failures.push('arena-path shot produced no impact');
  else {
    if (Math.abs(arenaPath.z - -19) > 1e-6) {
      failures.push(`arena-path shot should hit the static box front face z=-19; got z=${arenaPath.z}`);
    }
    if (Math.abs(arenaPath.normalZ - 1) > 1e-6) {
      failures.push(`arena-path impact normal should be +Z; got normalZ=${arenaPath.normalZ}`);
    }
    if (arenaPath.material !== 'metal') {
      failures.push(`arena-path impact should carry the box material 'metal'; got '${arenaPath.material}'`);
    }
  }

  return {
    name: 'weaponResolvesAgainstArena',
    pass: failures.length === 0,
    failures,
    detail: { scenePath, arenaPath },
  };
}

function run(): HarnessResult {
  const result: HarnessResult = { status: 'passed', collectionErrors: [], tests: [] };
  try {
    result.tests.push(testColliderResolvesBox());
    result.tests.push(testColliderNearestMissAndInvalid());
    result.tests.push(testWeaponResolvesAgainstArena());
    result.tests.push(testDynamicTargetAndWorldChooseNearest());
  } catch (error) {
    result.collectionErrors.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
  }
  result.status = result.collectionErrors.length > 0
    ? 'collection-error'
    : result.tests.every((t) => t.pass) ? 'passed' : 'failed';
  return result;
}

const result = run();
(window as unknown as { __STATICWORLD_RESULT__: HarnessResult }).__STATICWORLD_RESULT__ = result;
(window as unknown as { __STATICWORLD_READY__: boolean }).__STATICWORLD_READY__ = true;
// eslint-disable-next-line no-console
console.log('[staticworld]', JSON.stringify(result));
