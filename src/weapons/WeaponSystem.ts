/**
 * Fixed-step owns fire cadence, ADS timing, reload, recoil and hitscan.
 * Per-frame update owns FOV projection, viewmodel sway, flash and brass.
 */

import * as THREE from 'three';
import { Events, type EngineContext, type System, type UpdateContext } from '../core/contracts.js';
import { HitscanBallistics } from './Ballistics.js';
import { DUSKLINE_A7, type WeaponConfig } from './WeaponConfig.js';
import { RecoilModel, type RecoilSnapshot } from './Recoil.js';
import { ShellEjector } from './ShellEjector.js';
import { WeaponViewmodel, type ViewmodelPose } from './Viewmodel.js';
import type { AimChangedPayload } from './events.js';

const FIXED_STEP = 1 / 120;
const CAPTURE_SAMPLE_TICKS = 4;
const RANDOM_SEED = 0xd057a7;

export interface WeaponCapture {
  readonly name: string;
  readonly aim: number;
  readonly ammo: number;
  readonly recoil: RecoilSnapshot;
}

export class WeaponSystem implements System {
  readonly name = 'weapon';

  private readonly recoil: RecoilModel;
  private viewmodel!: WeaponViewmodel;
  private shells!: ShellEjector;
  private ballistics!: HitscanBallistics;
  private ctx!: EngineContext;

  private randomSource = mulberry32(RANDOM_SEED);
  private readonly random = (): number => this.randomSource();

  private baseFov = 75;
  private ammo: number;
  private reserve: number;
  private fireCooldown = 0;
  private previousFire = false;
  private previousReload = false;
  private adsProgress = 0;
  private reloading = false;
  private reloadRemaining = 0;

  private lookX = 0;
  private lookY = 0;
  private moveX = 0;
  private moveY = 0;
  private speed = 0;
  private walkPhase = 0;

  private captureFrozen = false;

  constructor(private readonly config: WeaponConfig = DUSKLINE_A7) {
    this.recoil = new RecoilModel(config);
    this.ammo = config.magazineSize;
    this.reserve = config.reserveAmmo;
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.baseFov = ctx.camera.fov;
    this.viewmodel = new WeaponViewmodel(
      this.config.flashSeconds,
      this.config.flashLightIntensity,
    );
    this.viewmodel.attach(ctx.camera, ctx.scene);
    this.shells = new ShellEjector(12, 0);
    ctx.scene.add(this.shells.mesh);
    this.ballistics = new HitscanBallistics(
      this.config,
      ctx.scene,
      ctx.bus,
      this.random,
    );
  }

  get aim(): number { return smoothstep(this.adsProgress); }
  get lookSensitivityScale(): number {
    return THREE.MathUtils.lerp(1, this.config.adsSensitivity, this.aim);
  }
  get magazineAmmo(): number { return this.ammo; }
  get reserveAmmo(): number { return this.reserve; }
  get isReloading(): boolean { return this.reloading; }

  fixedUpdate(step: number, ctx: EngineContext): void {
    if (this.captureFrozen) return;

    const aimTarget = ctx.input.aim && !this.reloading ? 1 : 0;
    const previousAim = this.aim;
    if (aimTarget > this.adsProgress) {
      this.adsProgress = Math.min(aimTarget, this.adsProgress + step / this.config.adsSeconds);
    } else if (aimTarget < this.adsProgress) {
      this.adsProgress = Math.max(aimTarget, this.adsProgress - step / this.config.adsSeconds);
    }
    const currentAim = this.aim;
    if (currentAim !== previousAim) {
      const payload: AimChangedPayload = {
        aiming: aimTarget === 1,
        t: currentAim,
        sensitivityScale: this.lookSensitivityScale,
      };
      ctx.bus.emit(Events.AimChanged, payload);
    }

    const reloadEdge = ctx.input.reload && !this.previousReload;
    this.previousReload = ctx.input.reload;
    if (reloadEdge) this.beginReload();

    if (this.reloading) {
      this.reloadRemaining -= step;
      if (this.reloadRemaining <= 0) this.finishReload();
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - step);
    const fireEdge = ctx.input.fire && !this.previousFire;
    const wantsFire = this.config.fireMode === 'auto' ? ctx.input.fire : fireEdge;
    this.previousFire = ctx.input.fire;

    if (wantsFire && !this.reloading && this.fireCooldown <= 0) {
      if (this.ammo > 0) {
        this.fireOnce(currentAim, true, true);
        this.fireCooldown += this.config.shotInterval;
      } else {
        this.beginReload();
      }
    }

    this.recoil.step(step);
  }

  update(update: UpdateContext, ctx: EngineContext): void {
    if (!this.captureFrozen) {
      const dt = Math.max(1e-4, update.dt);
      const targetLookX = THREE.MathUtils.clamp(ctx.input.look.x / 0.025, -1, 1);
      const targetLookY = THREE.MathUtils.clamp(ctx.input.look.y / 0.025, -1, 1);
      this.lookX = damp(this.lookX, targetLookX, 0.045, dt);
      this.lookY = damp(this.lookY, targetLookY, 0.045, dt);
      this.moveX = damp(this.moveX, ctx.input.move.x, 0.075, dt);
      this.moveY = damp(this.moveY, ctx.input.move.y, 0.075, dt);
      const targetSpeed = Math.min(1, Math.hypot(ctx.input.move.x, ctx.input.move.y));
      this.speed = damp(this.speed, targetSpeed, 0.11, dt);
      this.walkPhase += this.speed * 9.2 * dt;
      this.viewmodel.updateFlash(dt);
      this.shells.update(dt);
    }

    const recoil = this.recoil.snapshot();
    const pose: ViewmodelPose = {
      ads: this.aim,
      lookX: this.lookX,
      lookY: this.lookY,
      moveX: this.moveX,
      moveY: this.moveY,
      speed: this.speed,
      walkPhase: this.walkPhase,
      reload: this.reloadPose(),
      cameraPitch: recoil.cameraPitch,
      cameraYaw: recoil.cameraYaw,
      gunBack: recoil.gunBack,
      gunUp: recoil.gunUp,
      gunPitch: recoil.gunPitch,
      gunRoll: recoil.gunRoll,
      elapsed: this.captureFrozen ? 0 : update.elapsed,
    };
    this.viewmodel.applyPose(pose);
    this.applyViewProjection(ctx.camera);
  }

  /** Deterministic named states used by tools/shoot.mjs through the dev harness. */
  capture(name: string): WeaponCapture {
    this.resetCapture();

    if (name === 'ads') {
      this.adsProgress = 1;
    } else if (name === 'shot-1') {
      this.simulateBurst(1, 1);
    } else if (name === 'shot-5') {
      this.simulateBurst(5, 1);
    } else if (name === 'shot-15') {
      this.simulateBurst(15, 1);
    } else if (name === 'flash') {
      this.fireOnce(0, true, false);
      for (let tick = 0; tick < 2; tick++) this.recoil.step(FIXED_STEP);
      this.shells.update(0.028);
    } else if (name === 'sway') {
      this.lookX = 0.85;
      this.lookY = -0.3;
      this.moveX = 1;
      this.moveY = 0.6;
      this.speed = 1;
      this.walkPhase = Math.PI * 0.35;
    }

    this.captureFrozen = true;
    return {
      name,
      aim: this.aim,
      ammo: this.ammo,
      recoil: this.recoil.snapshot(),
    };
  }

  resume(): void {
    this.captureFrozen = false;
  }

  dispose(): void {
    this.viewmodel?.dispose();
    this.shells?.dispose();
  }

  private fireOnce(aim: number, visuals: boolean, emitShake = false): void {
    const camera = this.ctx.camera;
    camera.updateWorldMatrix(true, false);
    const quaternion = camera.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
    const cameraOrigin = camera.getWorldPosition(new THREE.Vector3());
    const muzzleOrigin = this.viewmodel.muzzleWorld(new THREE.Vector3());
    const recoilBeforeShot = this.recoil.snapshot();

    this.ammo--;
    this.ballistics.fire({
      cameraOrigin,
      muzzleOrigin,
      forward,
      right,
      up,
      recoilPitch: recoilBeforeShot.cameraPitch,
      recoilYaw: recoilBeforeShot.cameraYaw,
      spread: this.currentSpread(aim),
      ammo: this.ammo,
    });
    this.recoil.fire(aim);

    if (visuals) {
      this.viewmodel.triggerFlash(this.random);
      this.shells.eject(
        this.viewmodel.ejectionWorld(new THREE.Vector3()),
        right,
        up,
        forward,
        this.random,
      );
      if (emitShake) {
        this.ctx.bus.emit(Events.Shake, {
          amplitude: this.config.shakeAmplitude,
          duration: this.config.shakeSeconds,
          frequency: 34,
        });
      }
    }
  }

  private currentSpread(aim: number): number {
    const still = THREE.MathUtils.lerp(this.config.hipSpread, this.config.adsSpread, aim);
    return still + this.config.moveSpread * this.speed * (1 - aim * 0.68);
  }

  private beginReload(): void {
    if (this.reloading || this.ammo >= this.config.magazineSize || this.reserve <= 0) return;
    this.reloading = true;
    this.reloadRemaining = this.config.reloadSeconds;
    this.ctx.bus.emit(Events.ReloadStart, { weapon: this.config.id });
  }

  private finishReload(): void {
    const needed = this.config.magazineSize - this.ammo;
    const transferred = Math.min(needed, this.reserve);
    this.ammo += transferred;
    this.reserve -= transferred;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.ctx.bus.emit(Events.ReloadEnd, { weapon: this.config.id });
  }

  private reloadPose(): number {
    if (!this.reloading) return 0;
    const elapsed = 1 - this.reloadRemaining / this.config.reloadSeconds;
    return Math.sin(THREE.MathUtils.clamp(elapsed, 0, 1) * Math.PI);
  }

  /** Projection-centre shift reads as camera kick without fighting player rotation ownership. */
  private applyViewProjection(camera: THREE.PerspectiveCamera): void {
    camera.fov = THREE.MathUtils.lerp(this.baseFov, this.config.adsFov, this.aim);
    camera.updateProjectionMatrix();

    const recoil = this.recoil.snapshot();
    const verticalTan = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const horizontalTan = verticalTan * camera.aspect;
    camera.projectionMatrix.elements[8] += Math.tan(recoil.cameraYaw) / horizontalTan;
    camera.projectionMatrix.elements[9] += Math.tan(recoil.cameraPitch) / verticalTan;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  private simulateBurst(shots: number, aim: number): void {
    this.adsProgress = aim;
    const intervalTicks = Math.round(this.config.shotInterval / FIXED_STEP);
    for (let shot = 1; shot <= shots; shot++) {
      this.fireOnce(aim, false);
      const ticks = shot === shots ? CAPTURE_SAMPLE_TICKS : intervalTicks;
      for (let tick = 0; tick < ticks; tick++) this.recoil.step(FIXED_STEP);
    }
    this.viewmodel.clearFlash();
  }

  private resetCapture(): void {
    this.captureFrozen = false;
    this.randomSource = mulberry32(RANDOM_SEED);
    this.recoil.reset();
    this.viewmodel.clearFlash();
    this.shells.reset();
    this.ammo = this.config.magazineSize;
    this.reserve = this.config.reserveAmmo;
    this.fireCooldown = 0;
    this.previousFire = false;
    this.previousReload = false;
    this.adsProgress = 0;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.moveX = 0;
    this.moveY = 0;
    this.speed = 0;
    this.walkPhase = 0;
  }
}

function damp(current: number, target: number, seconds: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / seconds));
}

function smoothstep(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
