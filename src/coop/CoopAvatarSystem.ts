import * as THREE from 'three';
import type { EngineContext, System, UpdateContext } from '../core/contracts.js';
import type { PlayerSystem } from '../player/PlayerSystem.js';

interface AvatarSlot {
  readonly player: PlayerSystem;
  readonly visibleToLayer: number;
  readonly active: () => boolean;
  readonly alive: () => boolean;
  readonly color: number;
}

interface Avatar {
  readonly root: THREE.Group;
  readonly material: THREE.MeshStandardMaterial;
  readonly slot: AvatarSlot;
}

/**
 * Lightweight teammate bodies. Each body is visible only to the other camera's
 * layer, so neither player sees a third-person capsule around their own view.
 */
export class CoopAvatarSystem implements System {
  readonly name = 'coop-avatars';
  private readonly avatars: Avatar[] = [];
  private readonly scratch = new THREE.Vector3();

  constructor(private readonly slots: readonly AvatarSlot[]) {}

  init(ctx: EngineContext): void {
    for (const slot of this.slots) {
      const root = new THREE.Group();
      root.name = `coop-avatar:${slot.player.name}`;
      const material = new THREE.MeshStandardMaterial({
        color: slot.color,
        roughness: 0.62,
        metalness: 0.18,
      });
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.3, 0.85, 5, 10),
        material,
      );
      body.position.y = 0.72;
      body.castShadow = true;
      body.receiveShadow = true;
      const helmet = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 12, 8),
        material,
      );
      helmet.position.y = 1.48;
      helmet.scale.y = 0.82;
      helmet.castShadow = true;
      const visor = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.1, 0.08),
        new THREE.MeshStandardMaterial({
          color: 0x78d8ef,
          emissive: 0x226a80,
          emissiveIntensity: 1.5,
          roughness: 0.25,
        }),
      );
      visor.position.set(0, 1.5, -0.2);
      root.add(body, helmet, visor);
      root.traverse((object) => object.layers.set(slot.visibleToLayer));
      ctx.scene.add(root);
      this.avatars.push({ root, material, slot });
    }
  }

  update(_update: UpdateContext): void {
    for (const avatar of this.avatars) {
      const { slot, root, material } = avatar;
      const hasPosition = slot.player.copyFeetPosition(this.scratch);
      root.visible = hasPosition && slot.active();
      if (!root.visible) continue;
      root.position.copy(this.scratch);
      root.rotation.y = -slot.player.currentYaw;
      const alive = slot.alive();
      root.rotation.z = alive ? 0 : Math.PI / 2;
      material.opacity = alive ? 1 : 0.55;
      material.transparent = !alive;
    }
  }

  dispose(): void {
    for (const avatar of this.avatars) {
      avatar.root.removeFromParent();
      avatar.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const entry of material) entry.dispose();
        } else {
          material?.dispose();
        }
      });
    }
    this.avatars.length = 0;
  }
}
