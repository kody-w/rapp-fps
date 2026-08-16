import * as THREE from 'three';
import type { CampaignSystem } from '../campaign/CampaignSystem.js';
import {
  Events,
  type EngineContext,
  type System,
  type UpdateContext,
} from '../core/contracts.js';
import type { PlayerSystem } from '../player/PlayerSystem.js';
import type { WeaponSystem } from '../weapons/WeaponSystem.js';
import {
  ACTION_BUTTON,
  CoopInputManager,
  type GamepadAction,
  type GamepadInput,
  ManualEventTarget,
  ScriptedGamepadSource,
} from './input/index.js';
import { planCoopViewports, type CoopViewportPlan } from './render/index.js';
import type { CoopCombatSystem } from './CoopCombatSystem.js';

export interface CoopSessionOptions {
  readonly enabled: boolean;
  readonly fixture: boolean;
  readonly player2Spawn: THREE.Vector3;
  readonly renderer: THREE.WebGLRenderer;
  readonly campaign: CampaignSystem;
}

interface BoundRuntime {
  readonly player1: PlayerSystem;
  readonly player2: PlayerSystem;
  readonly weapon1: WeaponSystem;
  readonly weapon2: WeaponSystem;
  readonly combat: CoopCombatSystem;
}

export interface CoopPlayerEvidence {
  readonly id: 'player-1' | 'player-2';
  readonly active: boolean;
  readonly connected: boolean;
  readonly alive: boolean;
  readonly health: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly yaw: number;
  readonly ammo: number;
  readonly shotsFired: number;
  readonly input: {
    readonly move: { readonly x: number; readonly y: number };
    readonly look: { readonly x: number; readonly y: number };
    readonly fire: boolean;
    readonly aim: boolean;
  };
}

export class CoopSessionSystem implements System {
  readonly name = 'coop-session';
  readonly manager: CoopInputManager;
  readonly player2Input: GamepadInput;

  private readonly scriptedSource: ScriptedGamepadSource | null;
  private readonly manualEvents: ManualEventTarget | null;
  private readonly axes = [0, 0, 0, 0];
  private readonly buttons = new Map<number, number | boolean>();
  private runtime: BoundRuntime | null = null;
  private player2Active: boolean;
  private checkpointOpen = true;
  private previousStart = false;
  private promptState = '';
  private ctx: EngineContext | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly checkpointOrigin = new THREE.Vector3();
  private readonly checkpointFeet = new THREE.Vector3();
  private checkpointOriginSet = false;
  private disposed = false;
  private evidenceHandle: { readonly state: unknown } | null = null;

  constructor(private readonly options: CoopSessionOptions) {
    this.player2Active = options.fixture;
    if (options.fixture) {
      this.scriptedSource = new ScriptedGamepadSource();
      this.manualEvents = new ManualEventTarget();
      this.writeFixtureDevice(true);
      this.manager = new CoopInputManager({
        source: this.scriptedSource,
        events: this.manualEvents,
      });
    } else {
      this.scriptedSource = null;
      this.manualEvents = null;
      this.manager = new CoopInputManager();
    }
    this.player2Input = this.manager.join('player-2', 0);
  }

  bindRuntime(runtime: BoundRuntime): void {
    if (this.runtime) throw new Error('CoopSessionSystem runtime is already bound');
    this.runtime = runtime;
  }

  get isPlayer2Active(): boolean {
    return this.player2Active;
  }

  get playerCount(): 1 | 2 {
    return this.player2Active ? 2 : 1;
  }

  get renderPlan(): CoopViewportPlan {
    const size = this.options.renderer.getSize(new THREE.Vector2());
    return planCoopViewports({
      cssWidth: size.x,
      cssHeight: size.y,
      pixelRatio: this.options.renderer.getPixelRatio(),
      players: this.playerCount,
    });
  }

  init(ctx: EngineContext): void {
    if (!this.runtime) throw new Error('CoopSessionSystem.bindRuntime() is required before init');
    this.ctx = ctx;
    this.unsubscribers.push(
      ctx.bus.on<{ ownerId?: string | number }>(Events.WeaponFired, (event) => {
        if (event?.ownerId === 'player-1' || event?.ownerId === 'player-2') {
          this.closeCheckpoint();
        }
      }),
    );
    this.installEvidence();
  }

  update(update: UpdateContext): void {
    this.manager.sample(update.dt);
    if (!this.options.fixture) this.updateHardwareJoin();
    if (this.runtime?.player1.copyFeetPosition(this.checkpointFeet)) {
      if (!this.checkpointOriginSet) {
        this.checkpointOrigin.copy(this.checkpointFeet);
        this.checkpointOriginSet = true;
      } else if (
        this.checkpointOpen
        && this.checkpointFeet.distanceToSquared(this.checkpointOrigin) > 0.75 * 0.75
      ) {
        this.closeCheckpoint();
      }
    }
    this.publishJoinPrompt();
  }

  closeCheckpoint(): void {
    this.checkpointOpen = false;
  }

  openCheckpoint(): void {
    this.checkpointOpen = true;
  }

  refreshJoinPrompt(): void {
    this.publishJoinPrompt(true);
  }

  joinPlayer2(): void {
    this.requireCheckpoint('join');
    const runtime = this.requireRuntime();
    if (this.scriptedSource) this.writeFixtureDevice(true);
    this.manager.resumeAll();
    this.player2Active = true;
    runtime.combat.resetPlayer('player-2');
    runtime.weapon2.resetForCheckpoint();
    runtime.player2.getMotor()?.teleport(this.options.player2Spawn);
    this.publishJoinPrompt(true);
  }

  leavePlayer2(): void {
    this.requireCheckpoint('leave');
    this.player2Active = false;
    this.player2Input.release();
    this.publishJoinPrompt(true);
  }

  setFixtureAxes(axes: readonly number[]): void {
    this.requireFixture();
    for (let index = 0; index < 4; index++) this.axes[index] = axes[index] ?? 0;
    this.writeFixtureDevice(true);
  }

  setFixtureButton(action: GamepadAction, held: boolean): void {
    this.requireFixture();
    this.buttons.set(ACTION_BUTTON[action], held);
    this.writeFixtureDevice(true);
  }

  neutralFixture(): void {
    this.requireFixture();
    this.axes.fill(0);
    this.buttons.clear();
    this.writeFixtureDevice(true);
  }

  disconnectFixture(): void {
    this.requireFixture();
    this.scriptedSource!.disconnect(0);
    this.manualEvents!.dispatch('gamepaddisconnected', {
      gamepad: { index: 0, id: 'coop-fixture-pad' },
    });
    this.player2Active = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manager.dispose();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.ctx = null;
    const global = window as unknown as Record<string, unknown>;
    if (global.__COOP__ === this.evidenceHandle) delete global.__COOP__;
    if (this.options.fixture) delete global.__COOP_TEST__;
  }

  private get evidenceState(): unknown {
    const runtime = this.requireRuntime();
    const plan = this.renderPlan;
    const p1 = this.playerEvidence(
      'player-1',
      runtime.player1,
      runtime.weapon1,
      true,
      true,
      null,
    );
    const p2 = this.playerEvidence(
      'player-2',
      runtime.player2,
      runtime.weapon2,
      this.player2Active,
      this.player2Input.isConnected,
      this.player2Input,
    );
    return {
      active: true,
      mode: this.player2Active ? 'horizontal-split' : 'single-player',
      playerCount: this.playerCount,
      friendlyFire: false,
      joinPolicy: 'checkpoint-only',
      revivePolicy: 'checkpoint-respawn',
      checkpointOpen: this.checkpointOpen,
      inputSuspended: this.manager.isSuspended,
      lifecycleListeners: this.manualEvents?.listenerCount() ?? null,
      campaignTransitioning: this.options.campaign.isTransitioning,
      simulation: { worlds: 1, campaigns: 1, enemies: 1 },
      backingHeight: plan.renderable ? plan.backing.height : 0,
      viewports: plan.renderable ? plan.slots.map((slot) => slot.backing) : [],
      players: [p1, p2],
    };
  }

  private playerEvidence(
    id: 'player-1' | 'player-2',
    player: PlayerSystem,
    weapon: WeaponSystem,
    active: boolean,
    connected: boolean,
    input: GamepadInput | null,
  ): CoopPlayerEvidence {
    const runtime = this.requireRuntime();
    const position = new THREE.Vector3();
    player.copyFeetPosition(position);
    const health = runtime.combat.getPlayer(id);
    return {
      id,
      active,
      connected,
      alive: health.alive,
      health: health.health,
      position: { x: position.x, y: position.y, z: position.z },
      yaw: player.currentYaw,
      ammo: weapon.magazineAmmo,
      shotsFired: weapon.totalShotsFired,
      input: {
        move: {
          x: input?.move.x ?? 0,
          y: input?.move.y ?? 0,
        },
        look: {
          x: input?.look.x ?? 0,
          y: input?.look.y ?? 0,
        },
        fire: input?.fire ?? false,
        aim: input?.aim ?? false,
      },
    };
  }

  private installEvidence(): void {
    const self = this;
    const handle = {
      get state(): unknown {
        return self.evidenceState;
      },
    };
    this.evidenceHandle = handle;
    const global = window as unknown as Record<string, unknown>;
    global.__COOP__ = handle;
    if (!this.options.fixture) return;
    global.__COOP_TEST__ = {
      neutral: () => this.neutralFixture(),
      setAxes: (axes: readonly number[]) => this.setFixtureAxes(axes),
      setButton: (action: GamepadAction, held: boolean) => this.setFixtureButton(action, held),
      damagePlayer: (id: string, amount: number) => this.requireRuntime().combat.damagePlayer(id, amount),
      checkpoint: () => this.openCheckpoint(),
      closeCheckpoint: () => this.closeCheckpoint(),
      leavePlayer2: () => this.leavePlayer2(),
      joinPlayer2: () => this.joinPlayer2(),
      disconnect: () => this.disconnectFixture(),
      blur: () => this.manualEvents!.dispatch('blur'),
      focus: () => this.manualEvents!.dispatch('focus'),
      pagehide: () => this.manualEvents!.dispatch('pagehide', { persisted: true }),
      pageshow: () => this.manualEvents!.dispatch('pageshow', { persisted: true }),
    };
  }

  private writeFixtureDevice(connected: boolean): void {
    this.scriptedSource!.setSpec({
      index: 0,
      id: 'coop-fixture-pad',
      connected,
      axes: Object.fromEntries(this.axes.map((value, index) => [index, value])),
      buttons: Object.fromEntries(this.buttons),
      timestamp: performance.now(),
    });
  }

  private updateHardwareJoin(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[0];
    const start = Boolean(
      pad?.connected
      && pad.mapping === 'standard'
      && pad.buttons[9]?.pressed,
    );
    if (start && !this.previousStart && this.checkpointOpen) {
      if (this.player2Active) this.leavePlayer2();
      else this.joinPlayer2();
    }
    this.previousStart = start;
    if (this.player2Active && !this.player2Input.isConnected) {
      this.player2Active = false;
      this.publishJoinPrompt(true);
    }
  }

  private publishJoinPrompt(force = false): void {
    const bus = this.ctx?.bus;
    if (!bus || this.options.fixture) return;
    const next = this.player2Active
      ? ''
      : this.checkpointOpen
        ? 'P2 PRESS START'
        : 'P2 JOIN NEXT CHECKPOINT';
    const rendered = document.querySelector(
      '.coop-primary .hud-interaction-action',
    )?.textContent ?? '';
    if (!force && next === this.promptState && rendered === next) return;
    this.promptState = next;
    bus.emit(Events.InteractionChanged, next
      ? { action: next, binding: 'GAMEPAD' }
      : null);
  }

  private requireRuntime(): BoundRuntime {
    if (!this.runtime) throw new Error('CoopSessionSystem runtime is not bound');
    return this.runtime;
  }

  private requireFixture(): void {
    if (!this.options.fixture || !this.scriptedSource) {
      throw new Error('Coop fixture controls are unavailable outside ?coopFixture=1');
    }
  }

  private requireCheckpoint(action: string): void {
    if (!this.checkpointOpen) {
      throw new Error(`Player 2 may ${action} only at a checkpoint`);
    }
  }
}
