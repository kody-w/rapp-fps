/**
 * Fixed-step owns fire cadence, ADS timing, reload, recoil and hitscan.
 * Per-frame update owns FOV projection, viewmodel sway, flash and brass.
 */

import * as THREE from 'three';
import {
  Events,
  type EngineContext,
  type System,
  type UpdateContext,
  type WeaponStatusPayload,
} from '../core/contracts.js';
import { HitscanBallistics } from './Ballistics.js';
import { DUSKLINE_A7, type WeaponConfig } from './WeaponConfig.js';
import { RecoilModel, type RecoilSnapshot } from './Recoil.js';
import { ShellEjector } from './ShellEjector.js';
import { WeaponViewmodel, type ViewmodelPose } from './Viewmodel.js';
import type { AimChangedPayload } from './events.js';

const FIXED_STEP = 1 / 120;
const CAPTURE_SAMPLE_TICKS = 4;
const FIRE_EPSILON = 1e-9;
const RANDOM_SEED = 0xd057a7;
// Cosmetics draw from a stream separate from gameplay so that consuming a
// cosmetic random (muzzle flash, shell eject) cannot shift the bullet-deviation
// sequence. Sharing one stream meant a visuals-on live burst and a
// visuals-suppressed evidence capture fired different shot patterns.
const COSMETIC_SEED = 0x0c05e71c;

export interface WeaponCapture {
  readonly name: string;
  readonly aim: number;
  readonly ammo: number;
  readonly shotsFired: number;
  readonly recoil: RecoilSnapshot;
}

export class WeaponSystem implements System {
  readonly name = 'weapon';

  private readonly recoil: RecoilModel;
  private viewmodel!: WeaponViewmodel;
  private shells!: ShellEjector;
  private ballistics!: HitscanBallistics;
  private ctx!: EngineContext;

  private gameplayRandomSource = mulberry32(RANDOM_SEED);
  private readonly gameplayRandom = (): number => this.gameplayRandomSource();
  private cosmeticRandomSource = mulberry32(COSMETIC_SEED);
  private readonly cosmeticRandom = (): number => this.cosmeticRandomSource();

  private baseFov = 75;
  private ammo: number;
  private reserve: number;
  private simulationTime = 0;
  private nextShotAt = 0;
  private shotsFired = 0;
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
  private suppressCaptureVisuals = false;
  private lastStatusKey = '';

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
      this.gameplayRandom,
    );
    this.emitStatus();
  }

  get aim(): number { return smoothstep(this.adsProgress); }
  get lookSensitivityScale(): number {
    return THREE.MathUtils.lerp(1, this.config.adsSensitivity, this.aim);
  }
  get magazineAmmo(): number { return this.ammo; }
  get reserveAmmo(): number { return this.reserve; }
  get isReloading(): boolean { return this.reloading; }
  get isFlashActive(): boolean { return this.viewmodel.isFlashActive; }
  get totalShotsFired(): number { return this.shotsFired; }

  fixedUpdate(step: number, ctx: EngineContext): void {
    if (this.captureFrozen) return;
    this.simulationTime += step;

    // Movement spread is gameplay state — a fired round's cone reads this.speed,
    // so it must advance on the deterministic 120 Hz fixed step, not the render
    // frame. Integrating it in update() made a strafing player's accuracy depend
    // on their frame rate: a shot sampled the speed left by the previous rendered
    // frame, so the same input produced a different cone at 30 Hz than at 240 Hz.
    const targetSpeed = Math.min(1, Math.hypot(ctx.input.move.x, ctx.input.move.y));
    this.speed = damp(this.speed, targetSpeed, 0.11, step);

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
      this.maybeEmitStatus();
    }

    const reloadEdge = ctx.input.reload && !this.previousReload;
    this.previousReload = ctx.input.reload;
    if (reloadEdge) this.beginReload();

    if (this.reloading) {
      this.reloadRemaining -= step;
      this.nextShotAt = this.simulationTime;
      if (this.reloadRemaining <= 0) this.finishReload();
    }

    const triggerHeld = ctx.input.fire;
    const fireEdge = triggerHeld && !this.previousFire;
    const wantsFire = this.config.fireMode === 'auto' ? triggerHeld : fireEdge;
    this.previousFire = triggerHeld;

    // The outstanding deadline is preserved across trigger edges. A fresh pull
    // on a COLD action — the previous shot's deadline has already elapsed —
    // re-anchors the schedule to the round it is about to fire, so a burst's
    // first round is instant and the cadence that follows is exact. A pull
    // while a shot is still PENDING (rapid tapping, or a mashed semi trigger)
    // must not re-anchor: the deadline survives and the round waits, so no fire
    // mode can out-run its configured interval by cycling the trigger.
    if (fireEdge && this.simulationTime + FIRE_EPSILON >= this.nextShotAt) {
      this.nextShotAt = this.simulationTime;
    }

    if (wantsFire && !this.reloading && this.simulationTime + FIRE_EPSILON >= this.nextShotAt) {
      if (this.ammo > 0) {
        this.fireOnce(currentAim, !this.suppressCaptureVisuals);
        // Advance the absolute deadline, never `now + interval`: fractional
        // residue and overdue debt survive instead of rounding the rifle down.
        this.nextShotAt += this.config.shotInterval;
      } else {
        this.beginReload();
      }
    }

    this.recoil.step(step);
    // Fixed-step covers ammo, reload and ADS state transitions. Movement-driven
    // spread is quantised and published from the per-frame path instead.
    this.maybeEmitStatus();
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
      // this.speed is advanced on the fixed step (gameplay). walkPhase is
      // presentation-only viewmodel bob, so it may read speed at render rate.
      this.walkPhase += this.speed * 9.2 * dt;
      this.viewmodel.updateFlash(dt);
      this.shells.update(dt);
      // Movement changes spread but not ammo/aim; publish the normalised value
      // when its quantised bucket moves, so the HUD reticle tracks strafing
      // without emitting a status on every rendered frame.
      this.maybeEmitStatus();
    }

    this.applyViewmodelPose(this.captureFrozen ? 0 : update.elapsed);
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
    } else if (name === 'flash' || name === 'stress-fire') {
      this.fireOnce(0, true);
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
      shotsFired: this.shotsFired,
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

  private fireOnce(aim: number, visuals: boolean): void {
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
    this.shotsFired++;
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
      this.viewmodel.triggerFlash(this.cosmeticRandom);
      this.shells.eject(
        this.viewmodel.ejectionWorld(new THREE.Vector3()),
        right,
        up,
        forward,
        this.cosmeticRandom,
      );
    }
  }

  private beginReload(): void {
    if (this.reloading || this.ammo >= this.config.magazineSize || this.reserve <= 0) return;
    this.reloading = true;
    this.reloadRemaining = this.config.reloadSeconds;
    this.nextShotAt = this.simulationTime;
    this.ctx.bus.emit(Events.ReloadStart, { weapon: this.config.id });
  }

  private finishReload(): void {
    const needed = this.config.magazineSize - this.ammo;
    const transferred = Math.min(needed, this.reserve);
    this.ammo += transferred;
    this.reserve -= transferred;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.nextShotAt = this.simulationTime;
    this.ctx.bus.emit(Events.ReloadEnd, { weapon: this.config.id });
  }

  /** Radian cone half-angle the ballistics solver samples for this shot. */
  private currentSpread(aim: number): number {
    const still = THREE.MathUtils.lerp(this.config.hipSpread, this.config.adsSpread, aim);
    return still + this.config.moveSpread * this.speed * (1 - aim * 0.68);
  }

  /**
   * HUD-facing spread, normalised 0 (tightest) → 1 (widest) as the shared
   * WeaponStatus contract documents. The raw radian cone stays with ballistics;
   * only presentation is normalised. 0 is a still ADS shot (adsSpread); 1 is a
   * hip shot at full movement (hipSpread + moveSpread).
   */
  private normalizedSpread(): number {
    const minSpread = this.config.adsSpread;
    const maxSpread = this.config.hipSpread + this.config.moveSpread;
    const t = (this.currentSpread(this.aim) - minSpread) / (maxSpread - minSpread);
    return THREE.MathUtils.clamp(t, 0, 1);
  }

  /**
   * Quantised signature of everything the HUD renders from a status. Emitting
   * only when a bucket changes keeps strafe-driven spread live without spamming
   * a status on every rendered frame as damped values drift by a hair.
   */
  private statusKey(spread: number): string {
    return [
      this.ammo,
      this.reserve,
      this.reloading ? 1 : 0,
      Math.round(this.aim * 20),
      Math.round(spread * 25),
    ].join(':');
  }

  private maybeEmitStatus(): void {
    if (this.statusKey(this.normalizedSpread()) !== this.lastStatusKey) this.emitStatus();
  }

  private emitStatus(): void {
    const spread = this.normalizedSpread();
    this.lastStatusKey = this.statusKey(spread);
    const status: WeaponStatusPayload = {
      ammo: this.ammo,
      reserve: this.reserve,
      magazineSize: this.config.magazineSize,
      reloading: this.reloading,
      spread,
      aim: this.aim,
    };
    this.ctx.bus.emit(Events.WeaponStatus, status);
  }

  private reloadPose(): number {
    if (!this.reloading) return 0;
    const elapsed = 1 - this.reloadRemaining / this.config.reloadSeconds;
    return Math.sin(THREE.MathUtils.clamp(elapsed, 0, 1) * Math.PI);
  }

  private applyViewmodelPose(elapsed: number): void {
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
      elapsed,
    };
    this.viewmodel.applyPose(pose);
  }

  /** Projection-centre shift makes the recoil state steer both view and hitscan. */
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

  /** Capture recoil through the same scheduler path used by live fixedUpdate. */
  private simulateBurst(shots: number, aim: number): void {
    const input = this.ctx.input;
    const previous = { fire: input.fire, aim: input.aim, reload: input.reload };
    this.adsProgress = aim;
    this.applyViewmodelPose(0);
    input.fire = true;
    input.aim = aim === 1;
    input.reload = false;
    this.suppressCaptureVisuals = true;

    let guard = 0;
    while (this.shotsFired < shots && guard++ < shots * 20 + 20) {
      this.fixedUpdate(FIXED_STEP, this.ctx);
    }
    if (this.shotsFired !== shots) {
      throw new Error(`Capture scheduler produced ${this.shotsFired}/${shots} requested shots.`);
    }

    input.fire = false;
    for (let tick = 1; tick < CAPTURE_SAMPLE_TICKS; tick++) {
      this.fixedUpdate(FIXED_STEP, this.ctx);
    }

    this.suppressCaptureVisuals = false;
    input.fire = previous.fire;
    input.aim = previous.aim;
    input.reload = previous.reload;
    this.viewmodel.clearFlash();
    this.shells.reset();
  }

  private resetCapture(): void {
    this.captureFrozen = false;
    this.suppressCaptureVisuals = false;
    this.gameplayRandomSource = mulberry32(RANDOM_SEED);
    this.cosmeticRandomSource = mulberry32(COSMETIC_SEED);
    this.recoil.reset();
    this.viewmodel.clearFlash();
    this.shells.reset();
    this.lastStatusKey = '';
    this.ammo = this.config.magazineSize;
    this.reserve = this.config.reserveAmmo;
    this.simulationTime = 0;
    this.nextShotAt = 0;
    this.shotsFired = 0;
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
    this.applyViewmodelPose(0);
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
