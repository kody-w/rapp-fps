import type { SurfaceKind } from '../core/contracts.js';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface WeaponFiredPayload {
  origin: Vector3Like;
  direction: Vector3Like;
  weapon: unknown;
  spread: number;
}

export interface BulletImpactPayload {
  point: Vector3Like;
  normal: Vector3Like;
  material: SurfaceKind;
  distance: number;
}

export interface FootstepPayload {
  position: Vector3Like;
  surface: SurfaceKind;
  loud: number;
}

export interface DamagePayload {
  id: unknown;
  amount: number;
  point: Vector3Like;
  direction: Vector3Like;
  lethal: boolean;
}

export interface ListenerPose {
  position: Vector3Like;
  forward: Vector3Like;
  up: Vector3Like;
}

export type AudioArmState =
  | 'unarmed'
  | 'arming'
  | 'armed'
  | 'suspended'
  | 'interrupted'
  | 'unavailable'
  | 'closed';

export interface AudioStatus {
  state: AudioArmState;
  droppedWhileUnarmed: number;
  malformedEvents: number;
  lastError: string | null;
}

export interface SynthesisDiagnostics {
  eventsScheduled: number;
  voicesCreated: number;
  activeVoices: number;
  peakActiveVoices: number;
  sourcesCreated: number;
  activeSources: number;
  peakActiveSources: number;
  peakConcurrentSources: number;
  nodesCreated: number;
  maximumTailSeconds: number;
  latestScheduledEnd: number;
}

export const AUDIO_SURFACES = [
  'concrete',
  'metal',
  'wood',
  'sand',
  'glass',
  'flesh',
  'foliage',
  'water',
  'dirt',
  'fabric',
] as const satisfies readonly SurfaceKind[];

export function isFiniteVector3(value: unknown): value is Vector3Like {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Vector3Like>;
  return Number.isFinite(candidate.x)
    && Number.isFinite(candidate.y)
    && Number.isFinite(candidate.z);
}

export function isSurfaceKind(value: unknown): value is SurfaceKind {
  return typeof value === 'string'
    && (AUDIO_SURFACES as readonly string[]).includes(value);
}
