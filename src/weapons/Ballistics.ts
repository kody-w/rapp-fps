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
import { StaticWorldCollider } from './StaticWorldCollider.js';

/** A resolved hitscan impact, normalised across the scene-mesh and static-world paths. */
interface ResolvedHit {
  point: THREE.Vector3;
  /** Already in world space. */
  normal: THREE.Vector3;
  material: SurfaceKind;
  distance: number;
  targetId?: string | number;
}

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
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly instanceWorldMatrix = new THREE.Matrix4();

  /**
   * When set, hitscan resolves against the shipping arena's axis-aligned static
   * world (issue #32) instead of the scene graph. Cosmetic scene meshes never
   * block a round in the arena; the validated boxes are the only colliders. Left
   * null the ballistics fall back to the proven scene-mesh raycast, so every
   * existing harness and evidence capture is unaffected.
   */
  private staticWorld: StaticWorldCollider | null = null;

  constructor(
    private readonly config: WeaponConfig,
    private readonly scene: THREE.Scene,
    private readonly bus: EventBus,
    private readonly random: () => number,
  ) {
    this.raycaster.near = 0.001;
  }

  /** Route hitscan through the arena's static world, or back to the scene graph (null). */
  setStaticWorld(collider: StaticWorldCollider | null): void {
    this.staticWorld = collider;
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
    const cameraHit = this.resolveHit(
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

    const hit = this.resolveHit(
      shot.muzzleOrigin,
      this.muzzleDirection,
      distanceToAim + 0.01,
    );
    if (!hit) return { direction: this.muzzleDirection.clone(), impact: null };

    const impact: BulletImpactPayload = {
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      material: hit.material,
      distance: hit.distance,
      damage: this.damageAt(hit.distance),
      targetId: hit.targetId,
      source: shot.muzzleOrigin.clone(),
      direction: this.muzzleDirection.clone(),
    };
    this.bus.emit(Events.BulletImpact, impact);

    // Ballistics does not own health and cannot know whether this impact is
    // lethal. A coordinator-owned damage-request contract is required before
    // character damage is emitted; inventing `lethal: false` is worse than no event.
    return { direction: this.muzzleDirection.clone(), impact };
  }

  /**
   * Resolve the nearest ballistic hit along a ray, normalised across both worlds.
   * Static arena boxes answer analytically. Dynamic damage targets still answer
   * through the scene graph; the closest positive hit wins, so a target cannot
   * be shot through cover and a cosmetic level mesh cannot duplicate the
   * canonical AABB world.
   */
  private resolveHit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    far: number,
  ): ResolvedHit | null {
    const worldHit = this.staticWorld?.raycast(origin, direction, far) ?? null;
    const sceneHit = this.resolveSceneHit(origin, direction, far, this.staticWorld !== null);

    if (worldHit && (!sceneHit || worldHit.distance <= sceneHit.distance)) {
      return {
        point: worldHit.point,
        normal: worldHit.normal,
        material: worldHit.material,
        distance: worldHit.distance,
      };
    }
    return sceneHit;
  }

  private resolveSceneHit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    far: number,
    dynamicOnly: boolean,
  ): ResolvedHit | null {
    const hit = this.firstHit(origin, direction, far, dynamicOnly);
    if (!hit) return null;

    const normal = new THREE.Vector3();
    if (hit.face) {
      // The geometry normal is in the mesh's local space. For an InstancedMesh
      // the hit instance's true world transform is `matrixWorld × instanceMatrix`,
      // so transforming by `matrixWorld` alone drops the per-instance rotation
      // and scale and orients impacts on instanced geometry wrongly. Compose the
      // instance matrix when the hit carries an instanceId; fall back to the
      // object world matrix for ordinary meshes.
      const instanced = hit.object as THREE.InstancedMesh;
      if (instanced.isInstancedMesh === true && hit.instanceId != null) {
        instanced.getMatrixAt(hit.instanceId, this.instanceMatrix);
        this.instanceWorldMatrix.multiplyMatrices(hit.object.matrixWorld, this.instanceMatrix);
        normal.copy(hit.face.normal).transformDirection(this.instanceWorldMatrix).normalize();
      } else {
        normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
      }
    } else {
      normal.copy(direction).negate();
    }

    return {
      point: hit.point.clone(),
      normal,
      material: this.surfaceOf(hit.object),
      distance: hit.distance,
      targetId: this.damageTargetOf(hit.object),
    };
  }

  private firstHit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    far: number,
    dynamicOnly = false,
  ): THREE.Intersection | null {
    this.raycaster.far = far;
    this.raycaster.set(origin, direction);
    return this.raycaster.intersectObjects(this.scene.children, true)
      .find((candidate) => (
        this.isBallisticCollider(candidate.object)
        && (!dynamicOnly || this.damageTargetOf(candidate.object) !== undefined)
      )) ?? null;
  }

  /**
   * Ballistics resolves against world geometry only, by explicit OPT-IN. A mesh
   * stops a round when it (or an ancestor) is tagged `ballisticCollider === true`
   * or carries the level's `surfaceTag`/`surface` material vocabulary. Cosmetic
   * meshes — impact decals, tracers, particles, the viewmodel, ejected brass —
   * carry none of these and are transparent to bullets, so an InstancedMesh of
   * decals cannot silently intercept later rounds. An explicit opt-out
   * (`noHit === true` or `ballisticCollider === false`) always wins, so a
   * collider may still parent cosmetic children.
   *
   * This convention is LOCAL to ballistics today. Coordinator promotion is
   * requested so the calibration/art level and any destructible props are
   * tagged at the source rather than by the weapon harness.
   */
  private isBallisticCollider(object: THREE.Object3D): boolean {
    if ((object as THREE.Mesh).isMesh !== true) return false;
    let optIn = false;
    let current: THREE.Object3D | null = object;
    while (current) {
      const data = current.userData;
      if (data.noHit === true || data.ballisticCollider === false) return false;
      if (data.ballisticCollider === true) optIn = true;
      if (data.surfaceTag || data.surface) optIn = true;
      current = current.parent;
    }
    return optIn;
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

  private damageTargetOf(object: THREE.Object3D): string | number | undefined {
    let current: THREE.Object3D | null = object;
    while (current) {
      const target = current.userData.damageTargetId as string | number | undefined;
      if (target !== undefined) return target;
      current = current.parent;
    }
    return undefined;
  }
}
