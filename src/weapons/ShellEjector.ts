/** Cosmetic brass ejection in one pooled InstancedMesh (one draw call). */

import * as THREE from 'three';

interface ShellState {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  readonly spinAxis: THREE.Vector3;
  spinSpeed: number;
  life: number;
  active: boolean;
  bounced: boolean;
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);
const GRAVITY = -9.81;

export class ShellEjector {
  readonly mesh: THREE.InstancedMesh;

  private readonly shells: ShellState[];
  private readonly transform = new THREE.Matrix4();
  private readonly spinStep = new THREE.Quaternion();
  private next = 0;

  constructor(private readonly poolSize = 12, private readonly floorY = 0) {
    const geometry = new THREE.CylinderGeometry(0.006, 0.007, 0.028, 8, 1);
    const material = new THREE.MeshStandardMaterial({
      color: 0xc49a43,
      metalness: 1,
      roughness: 0.32,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, poolSize);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.noHit = true;
    this.mesh.name = 'duskline-shell-pool';

    this.shells = Array.from({ length: poolSize }, () => ({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      rotation: new THREE.Quaternion(),
      spinAxis: new THREE.Vector3(1, 0, 0),
      spinSpeed: 0,
      life: 0,
      active: false,
      bounced: false,
    }));
    this.reset();
  }

  eject(
    origin: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    forward: THREE.Vector3,
    random: () => number,
  ): void {
    const shell = this.shells[this.next];
    this.next = (this.next + 1) % this.poolSize;

    shell.position.copy(origin);
    shell.velocity.set(0, 0, 0)
      .addScaledVector(right, 1.45 + random() * 0.45)
      .addScaledVector(up, 1.15 + random() * 0.45)
      .addScaledVector(forward, -0.2 - random() * 0.25);
    shell.rotation.identity();
    shell.spinAxis.set(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
    shell.spinSpeed = 16 + random() * 12;
    shell.life = 1.8;
    shell.active = true;
    shell.bounced = false;
  }

  update(seconds: number): void {
    let changed = false;
    for (let index = 0; index < this.shells.length; index++) {
      const shell = this.shells[index];
      if (!shell.active) continue;
      changed = true;
      shell.life -= seconds;
      shell.velocity.y += GRAVITY * seconds;
      shell.position.addScaledVector(shell.velocity, seconds);

      if (shell.position.y < this.floorY + 0.007) {
        shell.position.y = this.floorY + 0.007;
        if (!shell.bounced && shell.velocity.y < 0) {
          shell.velocity.y *= -0.32;
          shell.velocity.x *= 0.62;
          shell.velocity.z *= 0.62;
          shell.bounced = true;
        } else {
          shell.velocity.set(0, 0, 0);
        }
      }

      this.spinStep.setFromAxisAngle(shell.spinAxis, shell.spinSpeed * seconds);
      shell.rotation.multiply(this.spinStep).normalize();

      if (shell.life <= 0) {
        shell.active = false;
        this.transform.compose(shell.position, shell.rotation, ZERO_SCALE);
      } else {
        this.transform.compose(shell.position, shell.rotation, UNIT_SCALE);
      }
      this.mesh.setMatrixAt(index, this.transform);
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset(): void {
    this.next = 0;
    for (let index = 0; index < this.shells.length; index++) {
      const shell = this.shells[index];
      shell.active = false;
      shell.life = 0;
      shell.position.set(0, this.floorY, 0);
      shell.velocity.set(0, 0, 0);
      shell.rotation.identity();
      this.transform.compose(shell.position, shell.rotation, ZERO_SCALE);
      this.mesh.setMatrixAt(index, this.transform);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    for (const material of materials) material.dispose();
  }
}
