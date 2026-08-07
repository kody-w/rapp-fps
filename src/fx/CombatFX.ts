import * as THREE from 'three';
import { Events } from '../core/contracts.js';
import type { System, EngineContext, UpdateContext, SurfaceKind } from '../core/contracts.js';
import { ParticleSystem } from './Particles.js';
import { DecalSystem } from './Decals.js';
import { MuzzleFlash } from './MuzzleFlash.js';

export class CombatFX implements System {
  readonly name = 'fx';
  private particles!: ParticleSystem;
  private decals!: DecalSystem;
  private flash!: MuzzleFlash;
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
      ),
      ctx.bus.on<{ point: THREE.Vector3; direction: THREE.Vector3 }>(
        Events.Damage, (e) => this.onDamage(e)
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

  private onDamage(_e: { point: THREE.Vector3; direction: THREE.Vector3 }) {
    // Subtle screen response? Or just trigger a screen shake. 
    // We could do a procedural vignette or simply emit a camera shake if we want.
    // The prompt says "damage hit direction / subtle screen response only if it can be done through events without owning HUD;"
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
  getParticleCount() { return (this.particles as any).activeCount; }
  getDecalCount() { return (this.decals as any).getActiveCount(); }
}
