/**
 * Procedural first-person viewmodel for the DUSKLINE A7. Finished, chamfered art
 * built by RifleGeometry.ts: every primary silhouette form is a rounded/authored
 * solid, sights are a layered rear aperture plus a front post between ears, and
 * functional cues (upper/lower receiver seam, stepped muzzle device, handguard
 * vents, trigger guard, ejection-port recess, charging handle, selector,
 * magazine segmentation, stock pad) are modelled. Material hierarchy is baked
 * into vertex colours. The rifle stays three merged material groups — metal,
 * polymer, accent — so it renders in three draw calls. This module owns pose
 * timing, sway, ADS, kick, muzzle flash and the muzzle/ejection anchors; the art
 * itself lives in RifleGeometry.ts.
 */

import * as THREE from 'three';
import {
  buildDusklineRifle,
  MUZZLE_ANCHOR,
  EJECTION_ANCHOR,
} from './RifleGeometry.js';

export interface ViewmodelPose {
  ads: number;
  lookX: number;
  lookY: number;
  moveX: number;
  moveY: number;
  speed: number;
  walkPhase: number;
  reload: number;
  cameraPitch: number;
  cameraYaw: number;
  gunBack: number;
  gunUp: number;
  gunPitch: number;
  gunRoll: number;
  elapsed: number;
}

interface LocalPose {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Euler;
}

const HIP: LocalPose = {
  position: new THREE.Vector3(0.225, -0.215, -0.48),
  rotation: new THREE.Euler(0.025, -0.055, 0.025),
};
const ADS: LocalPose = {
  position: new THREE.Vector3(0, -0.103, -0.62),
  rotation: new THREE.Euler(0, 0, 0),
};

export class WeaponViewmodel {
  readonly root = new THREE.Group();

  private readonly muzzle = new THREE.Object3D();
  private readonly ejectionPort = new THREE.Object3D();
  private readonly flashRoot = new THREE.Group();
  private readonly flashMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly muzzleLight: THREE.PointLight;
  private readonly resources: Array<{ dispose(): void }> = [];
  private flashRemaining = 0;

  constructor(
    private readonly flashSeconds: number,
    private readonly flashLightIntensity: number,
  ) {
    this.root.name = 'duskline-viewmodel';
    this.root.userData.noHit = true;
    this.buildRifle();

    this.muzzle.position.copy(MUZZLE_ANCHOR);
    this.ejectionPort.position.copy(EJECTION_ANCHOR);
    this.root.add(this.muzzle, this.ejectionPort);

    this.buildFlash();
    this.muzzleLight = new THREE.PointLight(0xffa45a, 0, 6.5, 2);
    this.muzzleLight.position.copy(this.muzzle.position);
    this.muzzleLight.castShadow = false;
    this.root.add(this.muzzleLight);

    this.applyPose({
      ads: 0, lookX: 0, lookY: 0, moveX: 0, moveY: 0, speed: 0,
      walkPhase: 0, reload: 0, cameraPitch: 0, cameraYaw: 0,
      gunBack: 0, gunUp: 0, gunPitch: 0, gunRoll: 0, elapsed: 0,
    });
  }

  get isFlashActive(): boolean { return this.flashRemaining > 0; }

  attach(camera: THREE.PerspectiveCamera, scene: THREE.Scene): void {
    if (camera.parent === null) scene.add(camera);
    camera.add(this.root);
  }

  setLayer(layer: number): void {
    this.root.traverse((object) => object.layers.set(layer));
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  applyPose(pose: ViewmodelPose): void {
    const ads = smoothstep(pose.ads);
    const steady = 1 - ads * 0.86;

    let x = THREE.MathUtils.lerp(HIP.position.x, ADS.position.x, ads);
    let y = THREE.MathUtils.lerp(HIP.position.y, ADS.position.y, ads);
    let z = THREE.MathUtils.lerp(HIP.position.z, ADS.position.z, ads);
    let pitch = THREE.MathUtils.lerp(HIP.rotation.x, ADS.rotation.x, ads);
    let yaw = THREE.MathUtils.lerp(HIP.rotation.y, ADS.rotation.y, ads);
    let roll = THREE.MathUtils.lerp(HIP.rotation.z, ADS.rotation.z, ads);

    // Look lag: the weapon trails camera motion, then settles. Movement lean
    // leads the body in the opposite direction, making the two motions readable.
    x -= pose.lookX * 0.028 * steady;
    y += pose.lookY * 0.021 * steady;
    yaw -= pose.lookX * 0.055 * steady;
    pitch += pose.lookY * 0.045 * steady;
    roll += pose.lookX * 0.035 * steady;

    x += pose.moveX * 0.009 * steady;
    z += Math.max(0, pose.moveY) * 0.012 * steady;
    roll -= pose.moveX * 0.065 * steady;

    // Distance-driven figure-eight bob. ADS keeps a residual 14%, rather than
    // becoming unnaturally locked to the centre of the screen.
    const bob = pose.speed * steady;
    x += Math.cos(pose.walkPhase) * 0.012 * bob;
    y -= Math.abs(Math.sin(pose.walkPhase)) * 0.014 * bob;
    roll += Math.cos(pose.walkPhase) * 0.027 * bob;

    const idle = (1 - pose.speed) * steady;
    x += Math.sin(pose.elapsed * 1.1) * 0.0015 * idle;
    y += Math.sin(pose.elapsed * 1.65 + 0.7) * 0.0013 * idle;

    // Camera recoil shifts the world projection. Counter that shift for the
    // camera-local model so camera kick and cosmetic gun kick remain distinct.
    // The depth is approximate because the blockout spans nearly a metre, but
    // keeping the sights stable is perceptually more important than exactness.
    const viewmodelCounterDepth = Math.abs(z) * 0.55;
    x += Math.tan(pose.cameraYaw) * viewmodelCounterDepth;
    y += Math.tan(pose.cameraPitch) * viewmodelCounterDepth;

    // Cosmetic gun motion does not steer the bullet; camera recoil does.
    z += pose.gunBack;
    y += pose.gunUp;
    pitch += pose.gunPitch;
    roll += pose.gunRoll;

    // A simple there-and-back reload pose supplied by WeaponSystem.
    x += pose.reload * 0.11;
    y -= pose.reload * 0.12;
    z += pose.reload * 0.045;
    pitch += pose.reload * 0.42;
    roll += pose.reload * 0.55;

    this.root.position.set(x, y, z);
    this.root.rotation.set(pitch, yaw, roll);
  }

  triggerFlash(random: () => number): void {
    this.flashRemaining = this.flashSeconds;
    this.flashRoot.rotation.z = random() * Math.PI * 2;
    const scale = 0.86 + random() * 0.32;
    this.flashRoot.scale.setScalar(scale);
    this.refreshFlash();
  }

  updateFlash(seconds: number): void {
    this.flashRemaining = Math.max(0, this.flashRemaining - seconds);
    this.refreshFlash();
  }

  clearFlash(): void {
    this.flashRemaining = 0;
    this.refreshFlash();
  }

  muzzleWorld(target: THREE.Vector3): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.muzzle.getWorldPosition(target);
  }

  ejectionWorld(target: THREE.Vector3): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.ejectionPort.getWorldPosition(target);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const resource of this.resources) resource.dispose();
  }

  private buildRifle(): void {
    const { metal, polymer, accent } = buildDusklineRifle();

    // Dark gunmetal, matte polymer and a subdued coyote-bronze accent. Each
    // group carries baked per-part vertex colours, so a single material per group
    // still resolves upper/lower, barrel, rail and hardware as distinct tones.
    const metalMaterial = new THREE.MeshStandardMaterial({
      color: 0x2b3138,
      metalness: 0.9,
      roughness: 0.44,
      vertexColors: true,
    });
    const polymerMaterial = new THREE.MeshStandardMaterial({
      color: 0x3b3f3a,
      metalness: 0.05,
      roughness: 0.8,
      vertexColors: true,
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: 0x8c6a3f,
      metalness: 0.72,
      roughness: 0.38,
      vertexColors: true,
    });
    this.resources.push(metalMaterial, polymerMaterial, accentMaterial);

    this.addRiflePart(metal, metalMaterial, 'metal');
    this.addRiflePart(polymer, polymerMaterial, 'polymer');
    this.addRiflePart(accent, accentMaterial, 'accent');
  }

  private addRiflePart(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
  ): void {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `duskline-${name}`;
    mesh.userData.noHit = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.root.add(mesh);
    this.resources.push(geometry);
  }

  private buildFlash(): void {
    const coneGeometry = new THREE.ConeGeometry(0.055, 0.20, 7, 1, true);
    coneGeometry.rotateX(-Math.PI / 2);
    const coneMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(8, 2.5, 0.45),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const cone = new THREE.Mesh(coneGeometry, coneMaterial);
    cone.position.set(0, 0.018, -1.01);
    cone.userData.noHit = true;

    const starGeometry = new THREE.PlaneGeometry(0.24, 0.24);
    const starMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(5.5, 1.5, 0.25),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const star = new THREE.Mesh(starGeometry, starMaterial);
    star.position.set(0, 0.018, -0.925);
    star.scale.set(1, 0.28, 1);
    star.userData.noHit = true;

    this.flashMaterials.push(coneMaterial, starMaterial);
    this.flashRoot.add(cone, star);
    this.flashRoot.visible = false;
    this.flashRoot.renderOrder = 1000;
    this.root.add(this.flashRoot);
    this.resources.push(coneGeometry, coneMaterial, starGeometry, starMaterial);
  }

  private refreshFlash(): void {
    if (this.flashRemaining <= 0) {
      this.flashRoot.visible = false;
      this.muzzleLight.intensity = 0;
      return;
    }
    const t = this.flashRemaining / this.flashSeconds;
    this.flashRoot.visible = true;
    this.flashMaterials[0].opacity = t;
    this.flashMaterials[1].opacity = t * 0.82;
    this.muzzleLight.intensity = this.flashLightIntensity * t * t;
  }
}

function smoothstep(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}
