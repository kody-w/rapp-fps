/**
 * Shared contracts. — owned by core, never edited by a subsystem agent.
 *
 * Every subsystem plugs in through these interfaces. They exist so that eight
 * agents can work in parallel on eight directories without reading each other's
 * source, and so that a subsystem can be swapped or stubbed without the engine
 * knowing. If two subsystems need to agree on something, it is defined HERE
 * once, rather than derived twice — the failure mode that costs the most.
 */

import type * as THREE from 'three';

/** Fixed-step simulation tick and variable-step render, kept distinct on purpose. */
export interface UpdateContext {
  /** Seconds since the previous frame, already clamped against tab-stalls. */
  dt: number;
  /** Seconds since engine start. */
  elapsed: number;
  /** Frame counter, useful for temporal effects that alternate. */
  frame: number;
  /** Interpolation alpha between the last two fixed steps, for smooth rendering. */
  alpha: number;
}

/**
 * Anything that participates in the frame.
 *
 * `fixedUpdate` runs at a constant rate for anything where frame-rate must not
 * change behaviour — movement, ballistics, AI. `update` runs once per rendered
 * frame for presentation: camera smoothing, viewmodel sway, particles.
 */
export interface System {
  readonly name: string;
  /** Called once, after the renderer exists and the scene is live. */
  init?(ctx: EngineContext): Promise<void> | void;
  /** Constant-rate simulation. */
  fixedUpdate?(step: number, ctx: EngineContext): void;
  /** Per-rendered-frame presentation. */
  update?(u: UpdateContext, ctx: EngineContext): void;
  /** Release GPU resources. */
  dispose?(): void;
}

/** What every system is handed. Read-only by convention. */
export interface EngineContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Wall-clock seconds since start. */
  time: number;
  /** Input state, sampled once per frame so every reader sees the same frame. */
  input: InputState;
  /** Cross-system events. Subsystems talk through this, never by importing each other. */
  bus: EventBus;
  /** Quality tier resolved at boot from measured GPU capability. */
  quality: QualityTier;
  /** Registry lookup so a system can find another by name without importing it. */
  get<T extends System>(name: string): T | undefined;
}

export interface InputState {
  /** -1..1 per axis, already deadzoned and normalised. */
  move: { x: number; y: number };
  /** Accumulated mouse delta for this frame, in radians after sensitivity. */
  look: { x: number; y: number };
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  fire: boolean;
  aim: boolean;
  reload: boolean;
  /** Edge-triggered: true only on the frame the key went down. */
  pressed: (action: string) => boolean;
}

/** Minimal typed pub/sub. Deliberately not a dependency on any framework. */
export interface EventBus {
  on<T = unknown>(event: string, fn: (payload: T) => void): () => void;
  emit<T = unknown>(event: string, payload?: T): void;
}

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

/** Events every subsystem may rely on. Named here so nobody invents a second spelling. */
export const Events = {
  /** A weapon discharged. `{ origin, direction, weapon, spread }` */
  WeaponFired: 'weapon:fired',
  /** A bullet resolved against the world. `{ point, normal, material, distance }` */
  BulletImpact: 'bullet:impact',
  /** A character took damage. `{ id, amount, point, direction, lethal }` */
  Damage: 'combat:damage',
  /** Reload began / finished. */
  ReloadStart: 'weapon:reload-start',
  ReloadEnd: 'weapon:reload-end',
  /** Aim-down-sights transition. `{ aiming: boolean, t: 0..1 }` */
  AimChanged: 'weapon:aim',
  /** Player landed after a fall. `{ impactSpeed }` — used for camera and audio. */
  Landed: 'player:landed',
  /** Footstep, for audio and AI hearing. `{ position, surface, loud }` */
  Footstep: 'player:footstep',
  /** Camera shake request. `{ amplitude, duration, frequency }` */
  Shake: 'camera:shake',
} as const;

/** Surfaces drive impact FX, decals, footsteps and audio from ONE vocabulary. */
export type SurfaceKind =
  | 'concrete' | 'metal' | 'wood' | 'sand' | 'glass'
  | 'flesh' | 'foliage' | 'water' | 'dirt' | 'fabric';

/** Attached to any mesh so a bullet can ask what it hit without a second lookup. */
export interface SurfaceTag {
  surface: SurfaceKind;
  /** Penetrable materials let rounds through with damage falloff. */
  penetration?: number;
}
