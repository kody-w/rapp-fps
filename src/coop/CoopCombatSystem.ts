import * as THREE from 'three';
import type { AiSystem } from '../ai/AiSystem.js';
import type { CombatSink, FireShot } from '../ai/types.js';
import type { StaticWorld } from '../core/collision.js';
import {
  Events,
  type DamagePayload,
  type EngineContext,
  type EventBus,
  type HitConfirmedPayload,
  type PlayerStatusPayload,
  type System,
} from '../core/contracts.js';
import type { BulletImpactPayload } from '../weapons/events.js';
import { StaticWorldCollider } from '../weapons/StaticWorldCollider.js';

export const CoopEvents = {
  PartyWiped: 'coop:party-wiped',
} as const;

export interface CoopCombatPlayer {
  readonly id: string;
  readonly eyeProvider: () => THREE.Vector3 | null;
  readonly maxHealth?: number;
}

interface PlayerState {
  readonly id: string;
  readonly eyeProvider: () => THREE.Vector3 | null;
  readonly maxHealth: number;
  health: number;
}

export interface CoopCombatSystemOptions {
  readonly world: StaticWorld;
  readonly players: readonly CoopCombatPlayer[];
  readonly enemyDamagePerShot?: number;
  readonly playerCollisionRadius?: number;
}

export interface CoopPlayerHealth {
  readonly id: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
}

/**
 * One enemy health authority plus independent local-player health slots.
 *
 * Player weapons carry `ownerId`; hit confirmation returns only to that owner.
 * Enemy shots carry the AI-selected `targetId`; damage is resolved only against
 * that living slot. Player weapons never resolve against player capsules, so
 * friendly fire is structurally disabled.
 */
export class CoopCombatSystem implements System {
  readonly name = 'combat';

  readonly enemySink: CombatSink = {
    onFire: (shot) => this.resolveEnemyShot(shot),
  };

  private readonly world: StaticWorldCollider;
  private readonly players = new Map<string, PlayerState>();
  private readonly enemyDamagePerShot: number;
  private readonly playerRadius: number;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly shotOrigin = new THREE.Vector3();
  private readonly shotDirection = new THREE.Vector3();
  private readonly playerCenter = new THREE.Vector3();
  private readonly sourceDirection = new THREE.Vector3();
  private ctx: EngineContext | null = null;
  private enemy: AiSystem | null = null;
  private wiped = false;

  constructor(options: CoopCombatSystemOptions) {
    if (options.players.length < 2) {
      throw new Error('CoopCombatSystem requires at least two player slots');
    }
    this.world = new StaticWorldCollider(options.world);
    this.enemyDamagePerShot = options.enemyDamagePerShot ?? 12;
    this.playerRadius = options.playerCollisionRadius ?? 0.42;
    for (const player of options.players) {
      if (!player.id.trim() || this.players.has(player.id)) {
        throw new Error(`CoopCombatSystem duplicate/empty player id "${player.id}"`);
      }
      const maxHealth = player.maxHealth ?? 100;
      this.players.set(player.id, {
        id: player.id,
        eyeProvider: player.eyeProvider,
        maxHealth,
        health: maxHealth,
      });
    }
  }

  bindEnemy(enemy: AiSystem): void {
    if (this.enemy && this.enemy !== enemy) {
      throw new Error('CoopCombatSystem: an enemy is already bound');
    }
    this.enemy = enemy;
  }

  getPlayer(id: string): CoopPlayerHealth {
    const player = this.requirePlayer(id);
    return this.snapshot(player);
  }

  get roster(): readonly CoopPlayerHealth[] {
    return [...this.players.values()].map((player) => this.snapshot(player));
  }

  isAlive(id: string): boolean {
    return this.requirePlayer(id).health > 0;
  }

  init(ctx: EngineContext): void {
    if (!this.enemy) {
      throw new Error('CoopCombatSystem: bindEnemy() is required before engine.init()');
    }
    this.ctx = ctx;
    this.unsubscribers.push(ctx.bus.on<BulletImpactPayload>(
      Events.BulletImpact,
      (impact) => this.resolvePlayerImpact(impact, ctx.bus),
    ));
    for (const player of this.players.values()) this.emitPlayerStatus(player, ctx.bus);
  }

  damagePlayer(id: string, amount: number, source?: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx) throw new Error('CoopCombatSystem is not initialised');
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`CoopCombatSystem damage must be finite and non-negative, got ${amount}`);
    }

    const player = this.requirePlayer(id);
    const eye = player.eyeProvider();
    if (!eye || player.health <= 0) return;
    const point = eye.clone().addScaledVector(THREE.Object3D.DEFAULT_UP, -0.48);
    const direction = source
      ? source.clone().sub(point).normalize()
      : new THREE.Vector3(0, 0, 1);
    this.applyPlayerDamage(player, amount, point, direction, ctx.bus);
  }

  resetPlayer(id: string): void {
    const player = this.requirePlayer(id);
    player.health = player.maxHealth;
    this.wiped = false;
    if (this.ctx) this.emitPlayerStatus(player, this.ctx.bus);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
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
    const confirmed: HitConfirmedPayload = {
      ownerId: impact.ownerId,
      lethal,
    };
    bus.emit(Events.HitConfirmed, confirmed);
  }

  private resolveEnemyShot(shot: FireShot): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const target = shot.targetId
      ? this.players.get(shot.targetId)
      : [...this.players.values()].find((player) => player.health > 0);
    if (!target || target.health <= 0) return;
    const eye = target.eyeProvider();
    if (!eye) return;

    this.shotOrigin.set(shot.origin.x, shot.origin.y, shot.origin.z);
    this.shotDirection.set(shot.direction.x, shot.direction.y, shot.direction.z).normalize();
    ctx.bus.emit(Events.WeaponFired, {
      ownerId: 'enemy',
      origin: this.shotOrigin.clone(),
      direction: this.shotDirection.clone(),
      weapon: 'enemy-carbine',
      spread: shot.aimError,
      ammo: 0,
    });

    this.playerCenter.copy(eye).addScaledVector(THREE.Object3D.DEFAULT_UP, -0.48);
    const playerDistance = raySphereEntry(
      this.shotOrigin,
      this.shotDirection,
      this.playerCenter,
      this.playerRadius,
    );
    if (playerDistance === null) return;
    const worldHit = this.world.raycast(this.shotOrigin, this.shotDirection, playerDistance);
    if (worldHit && worldHit.distance < playerDistance) return;

    const point = this.shotOrigin.clone().addScaledVector(
      this.shotDirection,
      playerDistance,
    );
    const direction = this.sourceDirection.copy(this.shotOrigin)
      .sub(this.playerCenter)
      .normalize();
    this.applyPlayerDamage(
      target,
      this.enemyDamagePerShot,
      point,
      direction,
      ctx.bus,
    );
  }

  private applyPlayerDamage(
    player: PlayerState,
    amount: number,
    point: THREE.Vector3,
    direction: THREE.Vector3,
    bus: EventBus,
  ): void {
    const previous = player.health;
    player.health = Math.max(0, previous - amount);
    const damage: DamagePayload = {
      id: player.id,
      amount: previous - player.health,
      point,
      direction: direction.clone(),
      lethal: player.health <= 0,
      health: player.health,
      maxHealth: player.maxHealth,
    };
    bus.emit(Events.Damage, damage);
    this.emitPlayerStatus(player, bus);

    const allDead = [...this.players.values()].every((entry) => entry.health <= 0);
    if (allDead && !this.wiped) {
      this.wiped = true;
      bus.emit(CoopEvents.PartyWiped, { playerIds: [...this.players.keys()] });
    }
  }

  private emitPlayerStatus(player: PlayerState, bus: EventBus): void {
    const payload: PlayerStatusPayload = {
      id: player.id,
      health: player.health,
      maxHealth: player.maxHealth,
    };
    bus.emit(Events.PlayerStatus, payload);
  }

  private requirePlayer(id: string): PlayerState {
    const player = this.players.get(id);
    if (!player) throw new Error(`CoopCombatSystem unknown player "${id}"`);
    return player;
  }

  private snapshot(player: PlayerState): CoopPlayerHealth {
    return {
      id: player.id,
      health: player.health,
      maxHealth: player.maxHealth,
      alive: player.health > 0,
    };
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
