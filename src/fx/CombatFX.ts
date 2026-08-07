import * as THREE from 'three';
import { Events } from '../core/contracts.js';
import type { System, EngineContext, UpdateContext, SurfaceKind } from '../core/contracts.js';
import { ParticleSystem } from './Particles.js';
import { DecalSystem } from './Decals.js';
import { MuzzleFlash } from './MuzzleFlash.js';

export class CombatFX implements System {
  readonly name = 'fx';
  public particles!: ParticleSystem;
  public decals!: DecalSystem;
  public flash!: MuzzleFlash;
  private unsubs: Array<() => void> = [];

  init(ctx: EngineContext): void {
    this.particles = new ParticleSystem(ctx.scene);
    this.decals = new DecalSystem(ctx.scene);
    this.flash = new MuzzleFlash(ctx.scene);

    this.unsubs.push(
      ctx.bus.on<{ origin: THREE.Vector3; direction: THREE.Vector3 }>(
        Events.WeaponFired, (e) => this.onFire(e)
      ),
      ctx.bus.on<{ point: THREE.Vector3; normal: THREE.Vector3; material: SurfaceKind }>(
        Events.BulletImpact, (e) => this.onImpact(e)
      )
    );
  }

  private onFire(e: { origin: THREE.Vector3; direction: THREE.Vector3 }) {
    this.flash.emit(e.origin, e.direction);
  }

  private onImpact(e: { point: THREE.Vector3; normal: THREE.Vector3; material: SurfaceKind }) {
    this.decals.emit(e.point, e.normal, e.material);
    this.particles.emit(e.point, e.normal, e.material);
  }

  update(u: UpdateContext, _ctx: EngineContext): void {
    this.particles.update(u.dt);
    this.decals.update(u.dt);
    this.flash.update(u.dt);
  }

  dispose(): void {
    this.unsubs.forEach(fn => fn());
    this.particles.dispose();
    this.decals.dispose();
    this.flash.dispose();
  }

  getParticleCount() { return this.particles.activeCount; }
  getDecalCount() { return this.decals.getActiveCount(); }
}
