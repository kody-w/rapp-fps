/**
 * Rifle ballistics are hitscan: across this calibration level, a supersonic
 * round's travel time is below a rendered frame. The camera selects the aim
 * point, then one authoritative ray travels from the muzzle to that point. The
 * event origin, event direction, obstruction test and impact therefore describe
 * the same physical line.
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
  private readonly cameraDirection = new THREE.Vector3();
  private readonly muzzleDirection = new THREE.Vector3();
  private readonly aimPoint = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();

  constructor(
    private readonly config: WeaponConfig,
    private readonly scene: THREE.Scene,
    private readonly bus: EventBus,
    private readonly random: () => number,
  ) {
    this.raycaster.near = 0.001;
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

    this.cameraDirection.copy(shot.forward)
      .addScaledVector(shot.right, Math.tan(yaw))
      .addScaledVector(shot.up, Math.tan(pitch))
      .normalize();

    // The camera answers only "what is the player aiming at?" It does not
    // resolve the bullet. A close wall beside the camera may block the muzzle
    // ray even when the camera has a clear sight picture.
    const cameraHit = this.firstHit(
      shot.cameraOrigin,
      this.cameraDirection,
      this.config.range,
    );
    if (cameraHit) {
      this.aimPoint.copy(cameraHit.point);
    } else {
      this.aimPoint.copy(shot.cameraOrigin)
        .addScaledVector(this.cameraDirection, this.config.range);
    }

    this.muzzleDirection.copy(this.aimPoint)
      .sub(shot.muzzleOrigin)
      .normalize();
    const distanceToAim = shot.muzzleOrigin.distanceTo(this.aimPoint);

    const fired: WeaponFiredPayload = {
      origin: shot.muzzleOrigin.clone(),
      direction: this.muzzleDirection.clone(),
      weapon: this.config.id,
      spread: shot.spread,
      ammo: shot.ammo,
    };
    this.bus.emit(Events.WeaponFired, fired);

    const hit = this.firstHit(
      shot.muzzleOrigin,
      this.muzzleDirection,
      distanceToAim + 0.01,
    );
    if (!hit) return { direction: this.muzzleDirection.clone(), impact: null };

    if (hit.face) {
      this.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
    } else {
      this.normal.copy(this.muzzleDirection).negate();
    }

    const material = this.surfaceOf(hit.object);
    const impact: BulletImpactPayload = {
      point: hit.point.clone(),
      normal: this.normal.clone(),
      material,
      distance: hit.distance,
      damage: this.damageAt(hit.distance),
    };
    this.bus.emit(Events.BulletImpact, impact);

    // Ballistics does not own health and cannot know whether this impact is
    // lethal. A coordinator-owned damage-request contract is required before
    // character damage is emitted; inventing `lethal: false` is worse than no event.
    return { direction: this.muzzleDirection.clone(), impact };
  }

  private firstHit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    far: number,
  ): THREE.Intersection | null {
    this.raycaster.far = far;
    this.raycaster.set(origin, direction);
    return this.raycaster.intersectObjects(this.scene.children, true)
      .find((candidate) => this.isSolid(candidate.object)) ?? null;
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
}
