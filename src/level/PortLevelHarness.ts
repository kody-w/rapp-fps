import * as THREE from 'three';
import type { EngineContext } from '../core/contracts.js';
import {
  PORT_LEVEL_LAYOUT,
  PortLevel,
  type PortLevelResourceSnapshot,
} from './PortLevel.js';

interface RendererMemory {
  geometries: number;
  textures: number;
  programs: number;
}

export interface PortLevelLifecycleCycle {
  cycle: number;
  baseline: RendererMemory;
  mounted: RendererMemory;
  released: RendererMemory;
  retainedBeforeDispose: PortLevelResourceSnapshot;
  retainedAfterDispose: PortLevelResourceSnapshot;
  memoryReturnedToBaseline: boolean;
  collectionsReleased: boolean;
}

export interface PortLevelLifecycleResult {
  cycles: PortLevelLifecycleCycle[];
  passed: boolean;
}

export interface PortLevelCollisionResult {
  maintenanceDoorRayClear: boolean;
  maintenanceDoorCapsuleClear: boolean;
  maintenanceJambRayBlocked: boolean;
  maintenanceJambCapsuleBlocked: boolean;
  checkpointRayClear: boolean;
  checkpointCapsuleClear: boolean;
  checkpointLeftPostRayBlocked: boolean;
  checkpointLeftPostCapsuleBlocked: boolean;
  checkpointRightPostRayBlocked: boolean;
  checkpointRightPostCapsuleBlocked: boolean;
  passed: boolean;
}

const rendererMemory = (renderer: THREE.WebGLRenderer): RendererMemory => ({
  geometries: renderer.info.memory.geometries,
  textures: renderer.info.memory.textures,
  programs: renderer.info.programs?.length ?? 0,
});

const retainedCollectionsReleased = (snapshot: PortLevelResourceSnapshot): boolean => (
  !snapshot.initialized
  && snapshot.visualChildren === 0
  && snapshot.collisionChildren === 0
  && snapshot.instancedMeshes === 0
  && snapshot.lights === 0
  && snapshot.shadowCastingDirectionalLights === 0
  && snapshot.geometries === 0
  && snapshot.geometryCacheEntries === 0
  && snapshot.colliders === 0
  && snapshot.steamFields === 0
  && snapshot.waterMarkers === 0
  && snapshot.rainBaseValues === 0
  && snapshot.materials.materials === 0
  && snapshot.materials.textures === 0
  && snapshot.materials.canvasSources === 0
  && snapshot.materials.canvasBackingPixels === 0
  && snapshot.materials.canvasBackingBytes === 0
);

export const runPortLevelLifecycleHarness = (
  context: EngineContext,
  cycles = 3,
): PortLevelLifecycleResult => {
  const { renderer } = context;
  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmapLevel = renderer.getActiveMipmapLevel();
  const previousShot = window.__SHOT__;
  const previousColliders = window.__LEVEL_COLLIDERS__;
  const previousTextureBytes = window.__LEVEL_TEXTURE_MEMORY_BYTES__;
  const results: PortLevelLifecycleCycle[] = [];

  try {
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const baseline = rendererMemory(renderer);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.05, 2000);
      camera.position.set(0.5, 1.68, 18);
      camera.lookAt(0, 1.7, -19);
      camera.updateMatrixWorld(true);
      const level = new PortLevel();
      const cycleContext: EngineContext = {
        ...context,
        scene,
        camera,
      };

      level.init(cycleContext);
      scene.updateMatrixWorld(true);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);

      const mounted = rendererMemory(renderer);
      const retainedBeforeDispose = level.getResourceSnapshot();
      level.dispose();
      scene.clear();
      renderer.renderLists.dispose();

      const retainedAfterDispose = level.getResourceSnapshot();
      const released = rendererMemory(renderer);
      const memoryReturnedToBaseline = (
        released.geometries === baseline.geometries
        && released.textures === baseline.textures
        && released.programs === baseline.programs
      );
      const collectionsReleased = retainedCollectionsReleased(retainedAfterDispose);
      results.push({
        cycle,
        baseline,
        mounted,
        released,
        retainedBeforeDispose,
        retainedAfterDispose,
        memoryReturnedToBaseline,
        collectionsReleased,
      });
    }
  } finally {
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    if (previousShot) window.__SHOT__ = previousShot;
    else delete window.__SHOT__;
    if (previousColliders) window.__LEVEL_COLLIDERS__ = previousColliders;
    else delete window.__LEVEL_COLLIDERS__;
    if (previousTextureBytes !== undefined) {
      window.__LEVEL_TEXTURE_MEMORY_BYTES__ = previousTextureBytes;
    } else {
      delete window.__LEVEL_TEXTURE_MEMORY_BYTES__;
    }
  }

  const passed = results.length === cycles && results.every((cycle) => (
    cycle.memoryReturnedToBaseline
    && cycle.collectionsReleased
    && cycle.retainedBeforeDispose.instancedMeshes >= 3
    && cycle.retainedBeforeDispose.shadowCastingDirectionalLights === 1
    && cycle.retainedBeforeDispose.materials.canvasSources === 7
    && cycle.retainedBeforeDispose.materials.canvasBackingBytes > 0
    && cycle.mounted.geometries > cycle.baseline.geometries
    && cycle.mounted.textures > cycle.baseline.textures
  ));

  return { cycles: results, passed };
};

const rayHits = (
  colliders: readonly THREE.Mesh[],
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  far: number,
): THREE.Intersection[] => {
  const ray = new THREE.Raycaster(origin, direction.normalize(), 0, far);
  return colliders
    .flatMap((collider) => ray.intersectObject(collider, false))
    .sort((a, b) => a.distance - b.distance);
};

const colliderBox = (mesh: THREE.Mesh): THREE.Box3 => {
  mesh.updateWorldMatrix(true, false);
  return new THREE.Box3().setFromObject(mesh);
};

const capsuleOverlaps = (
  colliders: readonly THREE.Mesh[],
  x: number,
  z: number,
  radius = 0.35,
  height = 1.8,
): boolean => {
  const segmentMinY = radius;
  const segmentMaxY = height - radius;
  for (const collider of colliders) {
    const box = colliderBox(collider).expandByScalar(radius);
    if (
      x >= box.min.x
      && x <= box.max.x
      && z >= box.min.z
      && z <= box.max.z
      && segmentMaxY >= box.min.y
      && segmentMinY <= box.max.y
    ) {
      return true;
    }
  }
  return false;
};

const named = (colliders: readonly THREE.Mesh[], prefix: string): THREE.Mesh[] => (
  colliders.filter((collider) => collider.name.startsWith(prefix))
);

export const runPortLevelCollisionHarness = (
  level: PortLevel,
): PortLevelCollisionResult => {
  const colliders = level.getCollisionMeshes();
  const maintenanceFront = named(colliders, 'maintenance-front-');
  const checkpoint = named(colliders, 'checkpoint-');
  const forward = new THREE.Vector3(0, 0, -1);

  const maintenanceDoorRayClear = rayHits(
    maintenanceFront,
    new THREE.Vector3(PORT_LEVEL_LAYOUT.maintenanceDoorCenterX, 1.2, -20.5),
    forward.clone(),
    3,
  ).length === 0;
  const maintenanceDoorCapsuleClear = !capsuleOverlaps(
    maintenanceFront,
    PORT_LEVEL_LAYOUT.maintenanceDoorCenterX,
    PORT_LEVEL_LAYOUT.maintenanceFrontZ,
  );
  const maintenanceJambRayBlocked = rayHits(
    maintenanceFront,
    new THREE.Vector3(5.5, 1.2, -20.5),
    forward.clone(),
    3,
  ).some((hit) => hit.object.name === 'maintenance-front-left');
  const maintenanceJambCapsuleBlocked = capsuleOverlaps(
    maintenanceFront,
    5.5,
    PORT_LEVEL_LAYOUT.maintenanceFrontZ,
  );

  const checkpointRayClear = rayHits(
    checkpoint,
    new THREE.Vector3(PORT_LEVEL_LAYOUT.checkpointCenterX, 1.2, -44.5),
    forward.clone(),
    3,
  ).length === 0;
  const checkpointCapsuleClear = !capsuleOverlaps(
    checkpoint,
    PORT_LEVEL_LAYOUT.checkpointCenterX,
    PORT_LEVEL_LAYOUT.checkpointZ,
  );
  const checkpointLeftPostRayBlocked = rayHits(
    checkpoint,
    new THREE.Vector3(-5.55, 1.2, -44.5),
    forward.clone(),
    3,
  ).some((hit) => hit.object.name === 'checkpoint-left-post');
  const checkpointLeftPostCapsuleBlocked = capsuleOverlaps(
    checkpoint,
    -5.55,
    PORT_LEVEL_LAYOUT.checkpointZ,
  );
  const checkpointRightPostRayBlocked = rayHits(
    checkpoint,
    new THREE.Vector3(1.95, 1.2, -44.5),
    forward.clone(),
    3,
  ).some((hit) => hit.object.name === 'checkpoint-right-post');
  const checkpointRightPostCapsuleBlocked = capsuleOverlaps(
    checkpoint,
    1.95,
    PORT_LEVEL_LAYOUT.checkpointZ,
  );

  const result = {
    maintenanceDoorRayClear,
    maintenanceDoorCapsuleClear,
    maintenanceJambRayBlocked,
    maintenanceJambCapsuleBlocked,
    checkpointRayClear,
    checkpointCapsuleClear,
    checkpointLeftPostRayBlocked,
    checkpointLeftPostCapsuleBlocked,
    checkpointRightPostRayBlocked,
    checkpointRightPostCapsuleBlocked,
    passed: false,
  };
  result.passed = Object.entries(result)
    .filter(([key]) => key !== 'passed')
    .every(([, value]) => value === true);
  return result;
};
