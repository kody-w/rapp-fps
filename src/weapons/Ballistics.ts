/**
 * Rifle ballistics are hitscan: across this calibration level, a supersonic
 * round's travel time is below a rendered frame. A fixed-step ray is cheaper,
 * deterministic, and gives the trigger immediate feedback. Slow/arcing weapons
 * should use a separate projectile implementation rather than weakening this one.
 */

import * as THREE from 'three';
import { Events, type EventBus, type SurfaceKind, type SurfaceTag } from '../core/contracts.js';
import type { WeaponConfig } from './WeaponConfig.js';
import type { BulletImpactPayload, WeaponFiredPayload } from './events.js';

export interface BallisticShot {
  cameraOrigin: THREE.Vector3;
  muzzleOrigin: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  recoilPitch: number;
  recoilYaw: number;
  spread: number;
  ammo: number;
}

export interface BallisticResult {
  readonly direction: THREE.Vector3;
  readonly impact: BulletImpactPayload | null;
}

export class HitscanBallistics {
  private readonly raycaster = new THREE.Raycaster();
  private readonly direction = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();

  constructor(
    private readonly config: WeaponConfig,
    private readonly scene: THREE.Scene,
    private readonly bus: EventBus,
    private readonly random: () => number,
  ) {
    this.raycaster.near = 0.01;
    this.raycaster.far = config.range;
  }

  damageAt(distance: number): number {
    if (distance <= this.config.falloffStart) return this.config.damage;
    if (distance >= this.config.falloffEnd) {
      return this.config.damage * this.config.falloffFloor;
    }
    const t = (distance - this.config.falloffStart)
      / (this.config.falloffEnd - this.config.falloffStart);
    return this.config.damage * (1 - t * (1 - this.config.falloffFloor));
  }

  fire(shot: BallisticShot): BallisticResult {
    // sqrt produces an even distribution over the cone's area rather than
    // clustering most samples at its centre.
    const radius = Math.sqrt(this.random()) * shot.spread;
    const azimuth = this.random() * Math.PI * 2;
    const yaw = shot.recoilYaw + Math.cos(azimuth) * radius;
    const pitch = shot.recoilPitch + Math.sin(azimuth) * radius;

    this.direction.copy(shot.forward)
      .addScaledVector(shot.right, Math.tan(yaw))
      .addScaledVector(shot.up, Math.tan(pitch))
      .normalize();

    const fired: WeaponFiredPayload = {
      origin: shot.muzzleOrigin.clone(),
      direction: this.direction.clone(),
      weapon: this.config.id,
      spread: shot.spread,
      ammo: shot.ammo,
    };
    this.bus.emit(Events.WeaponFired, fired);

    this.raycaster.set(shot.cameraOrigin, this.direction);
    const hit = this.raycaster.intersectObjects(this.scene.children, true)
      .find((candidate) => this.isSolid(candidate.object));
    if (!hit) return { direction: this.direction.clone(), impact: null };

    if (hit.face) {
      this.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
    } else {
      this.normal.copy(this.direction).negate();
    }

    const distance = hit.point.distanceTo(shot.muzzleOrigin);
    const material = this.surfaceOf(hit.object);
    const impact: BulletImpactPayload = {
      point: hit.point.clone(),
      normal: this.normal.clone(),
      material,
      distance,
      damage: this.damageAt(distance),
    };
    this.bus.emit(Events.BulletImpact, impact);

    const characterId = this.characterIdOf(hit.object);
    if (characterId !== undefined) {
      this.bus.emit(Events.Damage, {
        id: characterId,
        amount: impact.damage,
        point: impact.point.clone(),
        direction: this.direction.clone(),
        lethal: false,
      });
    }

    return { direction: this.direction.clone(), impact };
  }

  private isSolid(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (current.userData.noHit === true) return false;
      current = current.parent;
    }
    return (object as THREE.Mesh).isMesh === true;
  }

  private surfaceOf(object: THREE.Object3D): SurfaceKind {
    let current: THREE.Object3D | null = object;
    while (current) {
      const tag = current.userData.surfaceTag as SurfaceTag | undefined;
      if (tag?.surface) return tag.surface;
      const shorthand = current.userData.surface as SurfaceKind | undefined;
      if (shorthand) return shorthand;
      current = current.parent;
    }
    return 'concrete';
  }

  private characterIdOf(object: THREE.Object3D): string | number | undefined {
    let current: THREE.Object3D | null = object;
    while (current) {
      const id = current.userData.characterId as string | number | undefined;
      if (id !== undefined) return id;
      current = current.parent;
    }
    return undefined;
  }
}
