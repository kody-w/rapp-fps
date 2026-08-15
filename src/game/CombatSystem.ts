import * as THREE from 'three';
import {
  Events,
  type DamagePayload,
  type EngineContext,
  type EventBus,
  type HitConfirmedPayload,
  type PlayerStatusPayload,
  type System,
} from '../core/contracts.js';
import type { StaticWorld } from '../core/collision.js';
import type { AiSystem } from '../ai/AiSystem.js';
import type { CombatSink, FireShot } from '../ai/types.js';
import type { BulletImpactPayload } from '../weapons/events.js';
import { StaticWorldCollider } from '../weapons/StaticWorldCollider.js';

export interface CombatSystemOptions {
  world: StaticWorld;
  playerId?: string | number;
  playerMaxHealth?: number;
  enemyDamagePerShot?: number;
  playerCollisionRadius?: number;
  playerEyeProvider?: (ctx: EngineContext) => THREE.Vector3;
}

/**
 * Health authority and cross-subsystem combat adapter.
 *
 * Weapon and AI produce requests/events; neither owns another character's
 * health. This coordinator is the only place that turns a resolved player
 * impact into enemy damage or an AI FireShot into player damage.
 */
export class CombatSystem implements System {
  readonly name = 'combat';

  readonly enemySink: CombatSink = {
    onFire: (shot) => this.resolveEnemyShot(shot),
  };

  private readonly world: StaticWorldCollider;
  private readonly playerId: string | number;
  private readonly playerMaxHealth: number;
  private readonly enemyDamagePerShot: number;
  private readonly playerRadius: number;
  private readonly playerEyeProvider: (ctx: EngineContext) => THREE.Vector3;
  private readonly unsub: Array<() => void> = [];
  private readonly playerCenter = new THREE.Vector3();
  private readonly shotOrigin = new THREE.Vector3();
  private readonly shotDirection = new THREE.Vector3();
  private readonly sourceDirection = new THREE.Vector3();

  private ctx: EngineContext | null = null;
  private enemy: AiSystem | null = null;
  private playerHealth: number;

  constructor(options: CombatSystemOptions) {
    this.world = new StaticWorldCollider(options.world);
    this.playerId = options.playerId ?? 'player';
    this.playerMaxHealth = options.playerMaxHealth ?? 100;
    this.playerHealth = this.playerMaxHealth;
    this.enemyDamagePerShot = options.enemyDamagePerShot ?? 12;
    this.playerRadius = options.playerCollisionRadius ?? 0.42;
    this.playerEyeProvider = options.playerEyeProvider
      ?? ((ctx) => ctx.camera.position);
  }

  bindEnemy(enemy: AiSystem): void {
    if (this.enemy && this.enemy !== enemy) {
      throw new Error('CombatSystem: an enemy is already bound');
    }
    this.enemy = enemy;
  }

  get isPlayerAlive(): boolean { return this.playerHealth > 0; }
  get currentPlayerHealth(): number { return this.playerHealth; }

  init(ctx: EngineContext): void {
    if (!this.enemy) {
      throw new Error('CombatSystem: bindEnemy() is required before engine.init()');
    }
    this.ctx = ctx;
    this.unsub.push(ctx.bus.on<BulletImpactPayload>(
      Events.BulletImpact,
      (impact) => this.resolvePlayerImpact(impact, ctx.bus),
    ));
    this.emitPlayerStatus(ctx.bus);
  }

  dispose(): void {
    for (const unsubscribe of this.unsub) unsubscribe();
    this.unsub.length = 0;
    this.ctx = null;
  }

  private resolvePlayerImpact(impact: BulletImpactPayload, bus: EventBus): void {
    const enemy = this.enemy;
    if (!enemy || impact.targetId !== enemy.enemyId || enemy.state === 'dead') return;

    const health = Math.max(0, enemy.currentHealth - impact.damage);
    const lethal = health <= 0;
    const direction = this.sourceDirection.set(0, 0, 0);
    if (impact.source) {
      direction.copy(impact.source).sub(impact.point).normalize();
    } else if (impact.direction) {
      direction.copy(impact.direction).negate().normalize();
    }

    const damage: DamagePayload = {
      id: enemy.enemyId,
      amount: impact.damage,
      point: impact.point.clone(),
      direction: direction.clone(),
      lethal,
      health,
      maxHealth: enemy.maxHealth,
    };
    bus.emit(Events.Damage, damage);
    const confirmed: HitConfirmedPayload = { lethal };
    bus.emit(Events.HitConfirmed, confirmed);
  }

  private resolveEnemyShot(shot: FireShot): void {
    const ctx = this.ctx;
    if (!ctx || !this.isPlayerAlive) return;

    this.shotOrigin.set(shot.origin.x, shot.origin.y, shot.origin.z);
    this.shotDirection.set(shot.direction.x, shot.direction.y, shot.direction.z).normalize();
    ctx.bus.emit(Events.WeaponFired, {
      origin: this.shotOrigin.clone(),
      direction: this.shotDirection.clone(),
      weapon: 'enemy-carbine',
      spread: shot.aimError,
      ammo: 0,
    });

    const eye = this.playerEyeProvider(ctx);
    // The sphere is centred on upper torso rather than at the camera lens.
    this.playerCenter.copy(eye).addScaledVector(THREE.Object3D.DEFAULT_UP, -0.48);
    const playerDistance = raySphereEntry(
      this.shotOrigin,
      this.shotDirection,
      this.playerCenter,
      this.playerRadius,
    );
    if (playerDistance === null) return;

    const worldHit = this.world.raycast(
      this.shotOrigin,
      this.shotDirection,
      playerDistance,
    );
    if (worldHit && worldHit.distance < playerDistance) return;

    const previous = this.playerHealth;
    this.playerHealth = Math.max(0, previous - this.enemyDamagePerShot);
    const lethal = this.playerHealth <= 0;
    const point = this.shotOrigin.clone().addScaledVector(
      this.shotDirection,
      playerDistance,
    );
    const direction = this.sourceDirection.copy(this.shotOrigin)
      .sub(this.playerCenter)
      .normalize();
    const damage: DamagePayload = {
      id: this.playerId,
      amount: previous - this.playerHealth,
      point,
      direction: direction.clone(),
      lethal,
      health: this.playerHealth,
      maxHealth: this.playerMaxHealth,
    };
    ctx.bus.emit(Events.Damage, damage);
    this.emitPlayerStatus(ctx.bus);
  }

  private emitPlayerStatus(bus: EventBus): void {
    const payload: PlayerStatusPayload = {
      health: this.playerHealth,
      maxHealth: this.playerMaxHealth,
    };
    bus.emit(Events.PlayerStatus, payload);
  }
}

function raySphereEntry(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const projection = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = projection * projection - c;
  if (discriminant < 0) return null;
  const entry = -projection - Math.sqrt(discriminant);
  return entry > 1e-6 ? entry : null;
}
