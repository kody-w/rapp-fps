import type * as THREE from 'three';
import type { SurfaceKind } from '../core/contracts.js';

/** Payload emitted with the shared `Events.WeaponFired` name. */
export interface WeaponFiredPayload {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  weapon: string;
  spread: number;
  ammo: number;
}

/** Payload emitted with the shared `Events.BulletImpact` name. */
export interface BulletImpactPayload {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** The existing contract calls this field `material`; its value is SurfaceKind. */
  material: SurfaceKind;
  distance: number;
  damage: number;
  /** Present only when the nearest collider is a dynamic damage target. */
  targetId?: string | number;
  /** Authoritative shot line, copied so a health authority can attribute damage. */
  source?: THREE.Vector3;
  direction?: THREE.Vector3;
}

/** Extra field is local until the coordinator decides whether to extend AimChanged. */
export interface AimChangedPayload {
  aiming: boolean;
  t: number;
  sensitivityScale: number;
}
