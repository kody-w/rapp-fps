/**
 * Player calibration level. A box arena, not the game arena.
 *
 * Its job is to exercise exactly the locomotion the slice claims to support, so
 * every visual and every collision claim points at the same geometry:
 *
 *  - a flat floor to walk, sprint and stop on
 *  - a 0.30 m pad the motor must step onto
 *  - a 0.80 m wall the motor must refuse to climb
 *  - a four-step staircase up to a platform, to prove step-up, ground-snapped
 *    descent and a jumpable ledge
 *  - pillars to slide around, showing capsule sliding rather than sticking
 *  - a low lintel to crouch under, showing the headroom check
 *
 * The `world` field is the authoritative collision source (axis-aligned boxes
 * only). Every mesh added here is generated from the SAME box list, so what is
 * drawn is what is collided — there is no second, divergent topology.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/contracts.js';
import type { StaticBox, StaticWorld, SurfaceMaterial, Vec3 } from '../core/collision.js';

interface SurfaceLook {
  color: number;
  roughness: number;
  metalness: number;
}

const LOOKS: Readonly<Record<SurfaceMaterial, SurfaceLook>> = {
  concrete: { color: 0x3a3d42, roughness: 0.85, metalness: 0.0 },
  metal: { color: 0x8d9199, roughness: 0.35, metalness: 0.9 },
  wood: { color: 0x6b4a2f, roughness: 0.72, metalness: 0.0 },
  dirt: { color: 0x6a5a3a, roughness: 0.95, metalness: 0.0 },
};

/** Centre + size, the natural way to place a solid; converted to min/max AABB. */
function solid(
  cx: number, cy: number, cz: number,
  sx: number, sy: number, sz: number,
  material: SurfaceMaterial,
): StaticBox {
  return {
    min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
    max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
    material,
  };
}

function buildBoxes(): StaticBox[] {
  const boxes: StaticBox[] = [];

  // Floor: top at y = 0.
  boxes.push(solid(0, -0.5, 0, 40, 1, 40, 'concrete'));

  // Perimeter walls, 3 m tall.
  boxes.push(solid(0, 1.5, -16, 32.6, 3, 0.6, 'metal'));
  boxes.push(solid(0, 1.5, 16, 32.6, 3, 0.6, 'metal'));
  boxes.push(solid(16, 1.5, 0, 0.6, 3, 32.6, 'metal'));
  boxes.push(solid(-16, 1.5, 0, 0.6, 3, 32.6, 'metal'));

  // A single 0.30 m pad to step onto.
  boxes.push(solid(6, 0.15, 2, 3, 0.3, 3, 'metal'));

  // A 0.80 m wall the motor must refuse to climb.
  boxes.push(solid(-6, 0.4, 2, 3, 0.8, 0.6, 'concrete'));

  // Four-step staircase (each riser 0.30 m) up to a 1.20 m platform.
  for (let i = 0; i < 4; i++) {
    const top = 0.3 * (i + 1);
    boxes.push(solid(0, top / 2, -4 - i * 0.8, 4, top, 0.8, 'metal'));
  }
  boxes.push(solid(0, 0.6, -8.5, 4, 1.2, 4, 'wood'));

  // Pillars to slide around.
  boxes.push(solid(8, 1.5, -6, 0.8, 3, 0.8, 'wood'));
  boxes.push(solid(-8, 1.5, -6, 0.8, 3, 0.8, 'wood'));

  // A low lintel to crouch under: standing (1.78 m) is blocked, crouch (1.18 m)
  // clears. Two posts hold it up; the underside is at 1.40 m.
  boxes.push(solid(11, 0.9, -1, 0.4, 1.8, 0.4, 'metal'));
  boxes.push(solid(11, 0.9, -3, 0.4, 1.8, 0.4, 'metal'));
  boxes.push(solid(11, 1.6, -2, 0.4, 0.4, 2.4, 'metal'));

  return boxes;
}

function boundsFor(boxes: readonly StaticBox[]): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      if (box.min[axis] < min[axis]) min[axis] = box.min[axis];
      if (box.max[axis] > max[axis]) max[axis] = box.max[axis];
    }
  }
  // A margin so every solid sits strictly inside the declared play boundary and
  // there is headroom to jump against.
  return {
    min: [min[0] - 0.5, min[1] - 0.5, min[2] - 0.5],
    max: [max[0] + 0.5, max[1] + 2.0, max[2] + 0.5],
  };
}

export function createPlayerCalibrationWorld(): StaticWorld {
  const boxes = buildBoxes();
  return { boxes, bounds: boundsFor(boxes) };
}

export class PlayerCalibrationLevel implements System {
  readonly name = 'level';
  readonly world: StaticWorld;
  readonly spawn = new THREE.Vector3(0, 0, 6);

  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(world: StaticWorld = createPlayerCalibrationWorld()) {
    this.world = world;
  }

  init(ctx: EngineContext): void {
    const { scene } = ctx;
    scene.fog = new THREE.FogExp2(0x0b0e13, 0.014);

    // ── Lighting: warm key with real shadow, cool sky fill, warm bounce. ──
    const key = new THREE.DirectionalLight(0xfff1e0, 3.2);
    key.position.set(-8, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 60;
    const d = 20;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    scene.add(key);

    const sky = new THREE.HemisphereLight(0x9dc4ff, 0x2a2118, 0.5);
    scene.add(sky);

    const bounce = new THREE.PointLight(0xffa35c, 20, 26, 2);
    bounce.position.set(3, 2.4, -6);
    scene.add(bounce);

    const lampGeo = new THREE.SphereGeometry(0.16, 24, 16);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xffa35c,
      emissive: 0xffa35c,
      emissiveIntensity: 14,
      toneMapped: true,
    });
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.copy(bounce.position);
    scene.add(lamp);
    this.disposables.push(lampGeo, lampMat);

    // ── Solids: one mesh per collision box, from the same list. ──────────
    const materials = new Map<SurfaceMaterial, THREE.MeshStandardMaterial>();
    const materialFor = (surface: SurfaceMaterial): THREE.MeshStandardMaterial => {
      let material = materials.get(surface);
      if (!material) {
        const look = LOOKS[surface];
        material = new THREE.MeshStandardMaterial({
          color: look.color,
          roughness: look.roughness,
          metalness: look.metalness,
        });
        materials.set(surface, material);
        this.disposables.push(material);
      }
      return material;
    };

    for (const box of this.world.boxes) {
      const sx = box.max[0] - box.min[0];
      const sy = box.max[1] - box.min[1];
      const sz = box.max[2] - box.min[2];
      const geometry = new THREE.BoxGeometry(sx, sy, sz);
      this.disposables.push(geometry);
      const mesh = new THREE.Mesh(geometry, materialFor(box.material));
      mesh.position.set(
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
