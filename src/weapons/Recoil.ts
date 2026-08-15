import type { RecoilPoint, WeaponConfig } from './WeaponConfig.js';

export interface RecoilSnapshot {
  readonly cameraPitch: number;
  readonly cameraYaw: number;
  readonly targetPitch: number;
  readonly targetYaw: number;
  readonly gunBack: number;
  readonly gunUp: number;
  readonly gunPitch: number;
  readonly gunRoll: number;
  readonly nextShot: number;
  readonly secondsSinceShot: number;
}

const nearZero = (value: number): number => Math.abs(value) < 1e-9 ? 0 : value;

/**
 * Deterministic camera recoil plus a separate cosmetic viewmodel kick.
 * This class contains no random source and advances only from fixed simulation time.
 */
export class RecoilModel {
  private targetPitch = 0;
  private targetYaw = 0;
  private cameraPitch = 0;
  private cameraYaw = 0;

  private gunBack = 0;
  private gunUp = 0;
  private gunPitch = 0;
  private gunRoll = 0;

  private shotIndex = 0;
  private sinceShot = Number.POSITIVE_INFINITY;

  constructor(
    private readonly config: WeaponConfig,
    private readonly pattern: readonly RecoilPoint[] = config.recoilPattern,
  ) {
    if (pattern.length === 0) throw new Error('A recoil pattern must contain at least one shot.');
  }

  reset(): void {
    this.targetPitch = 0;
    this.targetYaw = 0;
    this.cameraPitch = 0;
    this.cameraYaw = 0;
    this.gunBack = 0;
    this.gunUp = 0;
    this.gunPitch = 0;
    this.gunRoll = 0;
    this.shotIndex = 0;
    this.sinceShot = Number.POSITIVE_INFINITY;
  }

  /** Register one discharge. Aim is 0 hip-fire .. 1 fully sighted. */
  fire(aim: number): RecoilPoint {
    if (this.sinceShot >= this.config.recoilResetSeconds) this.shotIndex = 0;
    const point = this.pattern[Math.min(this.shotIndex, this.pattern.length - 1)];
    const clampedAim = Math.max(0, Math.min(1, aim));
    const scale = 1 - (1 - this.config.adsRecoilScale) * clampedAim;
    const pitch = point.pitch * scale;
    const yaw = point.yaw * scale;

    this.targetPitch += pitch;
    this.targetYaw += yaw;

    // Viewmodel kick is intentionally separate from camera aim and accumulates
    // a little during automatic fire before its faster visual recovery.
    this.gunBack += this.config.gunKickBack;
    this.gunUp += this.config.gunKickUp;
    this.gunPitch += this.config.gunKickPitch;
    this.gunRoll += yaw * this.config.gunKickRollScale;

    this.shotIndex++;
    this.sinceShot = 0;
    return { pitch, yaw };
  }

  /** Advance deterministic springs. Gameplay calls this only from fixedUpdate. */
  step(seconds: number): void {
    if (!(seconds > 0) || !Number.isFinite(seconds)) {
      throw new Error(`Recoil step must be finite and positive; received ${seconds}.`);
    }
    this.sinceShot += seconds;

    if (this.sinceShot > this.config.recoilRecoveryDelay) {
      const recovery = Math.exp(-seconds / this.config.recoilRecoverySeconds);
      this.targetPitch *= recovery;
      this.targetYaw *= recovery;
    }

    const snap = 1 - Math.exp(-seconds / this.config.recoilSnapSeconds);
    this.cameraPitch += (this.targetPitch - this.cameraPitch) * snap;
    this.cameraYaw += (this.targetYaw - this.cameraYaw) * snap;

    const settle = Math.exp(-seconds / this.config.gunKickSettleSeconds);
    this.gunBack *= settle;
    this.gunUp *= settle;
    this.gunPitch *= settle;
    this.gunRoll *= settle;

    this.targetPitch = nearZero(this.targetPitch);
    this.targetYaw = nearZero(this.targetYaw);
    this.cameraPitch = nearZero(this.cameraPitch);
    this.cameraYaw = nearZero(this.cameraYaw);
    this.gunBack = nearZero(this.gunBack);
    this.gunUp = nearZero(this.gunUp);
    this.gunPitch = nearZero(this.gunPitch);
    this.gunRoll = nearZero(this.gunRoll);

    if (this.sinceShot >= this.config.recoilResetSeconds) this.shotIndex = 0;
  }

  snapshot(): RecoilSnapshot {
    return {
      cameraPitch: this.cameraPitch,
      cameraYaw: this.cameraYaw,
      targetPitch: this.targetPitch,
      targetYaw: this.targetYaw,
      gunBack: this.gunBack,
      gunUp: this.gunUp,
      gunPitch: this.gunPitch,
      gunRoll: this.gunRoll,
      nextShot: this.shotIndex,
      secondsSinceShot: this.sinceShot,
    };
  }
}
