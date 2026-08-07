/** All tuning for the first fictional rifle. No downloaded or branded assets are used. */

export type FireMode = 'auto' | 'semi';

export interface RecoilPoint {
  /** Upward camera impulse in radians. */
  pitch: number;
  /** Rightward camera impulse in radians. */
  yaw: number;
}

export interface WeaponConfig {
  readonly id: string;
  readonly displayName: string;
  readonly fireMode: FireMode;
  readonly rpm: number;
  readonly shotInterval: number;
  readonly magazineSize: number;
  readonly reserveAmmo: number;
  readonly reloadSeconds: number;

  readonly damage: number;
  readonly falloffStart: number;
  readonly falloffEnd: number;
  readonly falloffFloor: number;
  readonly range: number;

  readonly hipSpread: number;
  readonly adsSpread: number;
  readonly moveSpread: number;

  readonly adsFov: number;
  readonly adsSeconds: number;
  readonly adsSensitivity: number;

  readonly recoilPattern: readonly RecoilPoint[];
  readonly adsRecoilScale: number;
  readonly recoilSnapSeconds: number;
  readonly recoilRecoveryDelay: number;
  readonly recoilRecoverySeconds: number;
  readonly recoilResetSeconds: number;

  readonly gunKickBack: number;
  readonly gunKickUp: number;
  readonly gunKickPitch: number;
  readonly gunKickRollScale: number;
  readonly gunKickSettleSeconds: number;

  readonly flashSeconds: number;
  readonly flashLightIntensity: number;
  readonly shakeAmplitude: number;
  readonly shakeSeconds: number;
}

const DEG = Math.PI / 180;
const radians = (degrees: number): number => degrees * DEG;

/**
 * A deliberately authored pattern, not random jitter. It climbs right for the
 * opening rounds, crosses left through the middle, then returns right. Because
 * every magazine repeats this exact sequence, a player can learn and counter it.
 */
const DUSKLINE_PATTERN_DEGREES: ReadonlyArray<readonly [number, number]> = [
  [0.72, 0.00], [0.62, 0.08], [0.60, 0.13], [0.58, 0.18], [0.56, 0.20],
  [0.54, 0.12], [0.52, 0.02], [0.50, -0.10], [0.48, -0.18], [0.47, -0.24],
  [0.46, -0.28], [0.45, -0.26], [0.44, -0.22], [0.43, -0.15], [0.42, -0.08],
  [0.41, 0.02], [0.40, 0.12], [0.39, 0.20], [0.38, 0.26], [0.37, 0.28],
  [0.36, 0.24], [0.35, 0.16], [0.34, 0.05], [0.33, -0.06], [0.32, -0.15],
  [0.31, -0.20], [0.30, -0.18], [0.29, -0.10], [0.28, 0.02], [0.27, 0.12],
];

const recoilPattern = DUSKLINE_PATTERN_DEGREES.map(([pitch, yaw]) => ({
  pitch: radians(pitch),
  yaw: radians(yaw),
}));

/**
 * Duskline A7: a fictional, medium-rate automatic rifle tuned for readable kick.
 * Values are gameplay tuning, not a simulation of a real firearm.
 */
export const DUSKLINE_A7: WeaponConfig = {
  id: 'duskline-a7',
  displayName: 'Duskline A7',
  fireMode: 'auto',
  rpm: 720,
  shotInterval: 60 / 720,
  magazineSize: 30,
  reserveAmmo: 120,
  reloadSeconds: 2.1,

  damage: 28,
  falloffStart: 25,
  falloffEnd: 80,
  falloffFloor: 0.48,
  range: 400,

  hipSpread: radians(0.72),
  adsSpread: radians(0.08),
  moveSpread: radians(1.25),

  adsFov: 52,
  adsSeconds: 0.16,
  adsSensitivity: 0.62,

  recoilPattern,
  adsRecoilScale: 0.78,
  recoilSnapSeconds: 0.028,
  recoilRecoveryDelay: 0.105,
  recoilRecoverySeconds: 0.26,
  recoilResetSeconds: 0.32,

  gunKickBack: 0.032,
  gunKickUp: 0.007,
  gunKickPitch: radians(2.6),
  gunKickRollScale: 0.4,
  gunKickSettleSeconds: 0.075,

  flashSeconds: 0.045,
  flashLightIntensity: 52,
  shakeAmplitude: 0.0025,
  shakeSeconds: 0.07,
};
