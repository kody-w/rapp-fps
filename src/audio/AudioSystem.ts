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
  type ListenerPose,
  type QuaternionLike,
  type SynthesisDiagnostics,
  type Vector3Like,
  type WeaponFiredPayload,
} from './types.js';

export interface AudioSynthesisBackend {
  readonly diagnostics: SynthesisDiagnostics;
  setListenerPose(pose: ListenerPose): void;
  playWeaponFired(payload: unknown, when?: number): boolean;
  playBulletImpact(payload: unknown, when?: number): boolean;
  playFootstep(payload: unknown, when?: number): boolean;
  playReloadStart(when?: number): boolean;
  playReloadEnd(when?: number): boolean;
  playDamage(payload: unknown, when?: number): boolean;
  dispose(): void;
}

export interface AudioSystemOptions extends ProceduralAudioEngineOptions {
  contextFactory?: () => AudioContext;
  synthesisFactory?: (
    context: BaseAudioContext,
    options: ProceduralAudioEngineOptions,
  ) => AudioSynthesisBackend;
}

type StatusListener = (status: AudioStatus) => void;
type ExtendedAudioContextState = AudioContextState | 'interrupted';

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
  private synthesis: AudioSynthesisBackend | null = null;
  private armState: AudioArmState = 'unarmed';
  private armGeneration = 0;
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
    if (
      this.context
      && this.contextState(this.context) === 'running'
      && this.synthesis
    ) {
      this.setState('armed');
      return true;
    }

    const generation = ++this.armGeneration;
    this.lastError = null;
    this.setState('arming');
    let context = this.context;

    if (!context) {
      try {
        context = this.options.contextFactory?.() ?? this.createContext();
        if (!this.isCurrentArm(generation)) {
          if (this.contextState(context) !== 'closed') void context.close();
          return false;
        }
        this.context = context;
        context.addEventListener('statechange', this.onContextStateChange);
        this.synthesis = this.options.synthesisFactory?.(context, this.options)
          ?? new ProceduralAudioEngine(context, this.options);
      } catch (error) {
        if (!this.isCurrentArm(generation)) return false;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.releaseContext(context);
        this.setState('unavailable');
        return false;
      }
    }

    try {
      await context.resume();
    } catch (error) {
      if (!this.isCurrentArm(generation, context)) return false;
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.applyContextState(context);
    }

    if (!this.isCurrentArm(generation, context)) return false;
    return this.applyContextState(context);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.armGeneration++;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.releaseContext(this.context);
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

  private schedule(play: (engine: AudioSynthesisBackend) => boolean): void {
    if (
      this.armState !== 'armed'
      || !this.context
      || this.contextState(this.context) !== 'running'
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
    this.applyContextState(this.context);
  };

  private applyContextState(context: AudioContext): boolean {
    const state = this.contextState(context);
    if (state === 'running') {
      this.setState('armed');
      return true;
    }
    if (state === 'interrupted') {
      this.setState('interrupted');
      return false;
    }
    if (state === 'suspended') {
      this.setState('suspended');
      return false;
    }
    this.releaseContext(context);
    this.setState('closed');
    return false;
  }

  private contextState(context: AudioContext): ExtendedAudioContextState {
    return (context as AudioContext & { state: ExtendedAudioContextState }).state;
  }

  private isCurrentArm(
    generation: number,
    context: AudioContext | null = this.context,
  ): boolean {
    return !this.disposed
      && generation === this.armGeneration
      && (context === null || this.context === context);
  }

  private releaseContext(context: AudioContext | null): void {
    this.synthesis?.dispose();
    this.synthesis = null;
    if (!context) return;
    context.removeEventListener('statechange', this.onContextStateChange);
    if (this.context === context) this.context = null;
    if (this.contextState(context) !== 'closed') void context.close();
  }

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
