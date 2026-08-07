import {
  Events,
  type EngineContext,
  type EventBus,
  type System,
  type UpdateContext,
} from '../core/contracts.js';
import {
  ProceduralAudioEngine,
  type ProceduralAudioEngineOptions,
} from './ProceduralAudioEngine.js';
import {
  type AudioArmState,
  type AudioStatus,
  type BulletImpactPayload,
  type DamagePayload,
  type FootstepPayload,
  type QuaternionLike,
  type SynthesisDiagnostics,
  type Vector3Like,
  type WeaponFiredPayload,
} from './types.js';

export interface AudioSystemOptions extends ProceduralAudioEngineOptions {
  contextFactory?: () => AudioContext;
}

type StatusListener = (status: AudioStatus) => void;

const rotateVector = (
  vector: Vector3Like,
  quaternion: QuaternionLike,
): Vector3Like => {
  const ix = quaternion.w * vector.x
    + quaternion.y * vector.z
    - quaternion.z * vector.y;
  const iy = quaternion.w * vector.y
    + quaternion.z * vector.x
    - quaternion.x * vector.z;
  const iz = quaternion.w * vector.z
    + quaternion.x * vector.y
    - quaternion.y * vector.x;
  const iw = -quaternion.x * vector.x
    - quaternion.y * vector.y
    - quaternion.z * vector.z;

  return {
    x: ix * quaternion.w + iw * -quaternion.x
      + iy * -quaternion.z - iz * -quaternion.y,
    y: iy * quaternion.w + iw * -quaternion.y
      + iz * -quaternion.x - ix * -quaternion.z,
    z: iz * quaternion.w + iw * -quaternion.z
      + ix * -quaternion.y - iy * -quaternion.x,
  };
};

export class AudioSystem implements System {
  readonly name = 'audio';

  private readonly options: AudioSystemOptions;
  private readonly statusListeners = new Set<StatusListener>();
  private readonly unsubscribers: Array<() => void> = [];
  private context: AudioContext | null = null;
  private synthesis: ProceduralAudioEngine | null = null;
  private armState: AudioArmState = 'unarmed';
  private droppedWhileUnarmed = 0;
  private malformedEvents = 0;
  private lastError: string | null = null;
  private disposed = false;

  constructor(options: AudioSystemOptions = {}) {
    this.options = options;
  }

  get status(): AudioStatus {
    return {
      state: this.armState,
      droppedWhileUnarmed: this.droppedWhileUnarmed,
      malformedEvents: this.malformedEvents,
      lastError: this.lastError,
    };
  }

  get diagnostics(): SynthesisDiagnostics | null {
    return this.synthesis?.diagnostics ?? null;
  }

  init(ctx: EngineContext): void {
    if (this.disposed || this.unsubscribers.length > 0) return;
    this.subscribe<WeaponFiredPayload>(
      ctx.bus,
      Events.WeaponFired,
      (payload) => this.schedule((engine) => engine.playWeaponFired(payload)),
    );
    this.subscribe<BulletImpactPayload>(
      ctx.bus,
      Events.BulletImpact,
      (payload) => this.schedule((engine) => engine.playBulletImpact(payload)),
    );
    this.subscribe<FootstepPayload>(
      ctx.bus,
      Events.Footstep,
      (payload) => this.schedule((engine) => engine.playFootstep(payload)),
    );
    this.subscribe(
      ctx.bus,
      Events.ReloadStart,
      () => this.schedule((engine) => engine.playReloadStart()),
    );
    this.subscribe(
      ctx.bus,
      Events.ReloadEnd,
      () => this.schedule((engine) => engine.playReloadEnd()),
    );
    this.subscribe<DamagePayload>(
      ctx.bus,
      Events.Damage,
      (payload) => this.schedule((engine) => engine.playDamage(payload)),
    );
  }

  update(update: UpdateContext, ctx: EngineContext): void {
    void update;
    if (!this.synthesis) return;
    const camera = ctx.camera;
    this.synthesis.setListenerPose({
      position: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
      forward: rotateVector(
        { x: 0, y: 0, z: -1 },
        camera.quaternion,
      ),
      up: rotateVector(
        { x: 0, y: 1, z: 0 },
        camera.quaternion,
      ),
    });
  }

  /**
   * Must be called directly from a user gesture. No AudioContext is created
   * before this call, and events received before a running context are dropped.
   */
  async arm(): Promise<boolean> {
    if (this.disposed || this.armState === 'closed') return false;
    if (this.context?.state === 'running' && this.synthesis) {
      this.setState('armed');
      return true;
    }

    this.lastError = null;
    this.setState('arming');
    try {
      if (!this.context) {
        const context = this.options.contextFactory?.() ?? this.createContext();
        this.context = context;
        context.addEventListener('statechange', this.onContextStateChange);
        this.synthesis = new ProceduralAudioEngine(context, this.options);
      }

      await this.context.resume();
      if (this.context.state !== 'running') {
        this.setState('suspended');
        return false;
      }

      this.setState('armed');
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.synthesis?.dispose();
      this.synthesis = null;
      if (this.context) {
        this.context.removeEventListener('statechange', this.onContextStateChange);
        if (this.context.state !== 'closed') void this.context.close();
      }
      this.context = null;
      this.setState('unavailable');
      return false;
    }
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.synthesis?.dispose();
    this.synthesis = null;
    if (this.context) {
      this.context.removeEventListener('statechange', this.onContextStateChange);
      if (this.context.state !== 'closed') void this.context.close();
      this.context = null;
    }
    this.setState('closed');
    this.statusListeners.clear();
  }

  private subscribe<T>(
    bus: EventBus,
    event: string,
    listener: (payload: T) => void,
  ): void {
    this.unsubscribers.push(bus.on<T>(event, listener));
  }

  private schedule(play: (engine: ProceduralAudioEngine) => boolean): void {
    if (
      this.armState !== 'armed'
      || this.context?.state !== 'running'
      || !this.synthesis
    ) {
      this.droppedWhileUnarmed++;
      this.notifyStatus();
      return;
    }

    if (!play(this.synthesis)) {
      this.malformedEvents++;
      this.notifyStatus();
    }
  }

  private createContext(): AudioContext {
    const scope = globalThis as typeof globalThis & {
      webkitAudioContext?: new (options?: AudioContextOptions) => AudioContext;
    };
    const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Constructor) throw new Error('Web Audio is unavailable in this browser.');
    return new Constructor({ latencyHint: 'interactive' });
  }

  private onContextStateChange = (): void => {
    if (this.disposed || !this.context) return;
    if (this.context.state === 'running') {
      this.setState('armed');
    } else if (this.context.state === 'suspended') {
      this.setState('suspended');
    } else {
      this.setState('closed');
    }
  };

  private setState(state: AudioArmState): void {
    if (this.armState === state) return;
    this.armState = state;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    const status = this.status;
    for (const listener of this.statusListeners) listener(status);
  }
}
