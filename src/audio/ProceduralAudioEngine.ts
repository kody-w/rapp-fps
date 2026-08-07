import type { SurfaceKind } from '../core/contracts.js';
import { DeterministicRandom } from './random.js';
import {
  isFiniteVector3,
  isSurfaceKind,
  type BulletImpactPayload,
  type DamagePayload,
  type FootstepPayload,
  type ListenerPose,
  type SynthesisDiagnostics,
  type Vector3Like,
  type WeaponFiredPayload,
} from './types.js';

export interface ProceduralAudioEngineOptions {
  seed?: number;
  limiterEnabled?: boolean;
  masterGain?: number;
}

export const LIMITER_OUTPUT_CEILING = 0.55;

interface Voice {
  nodes: AudioNode[];
  remainingSources: number;
  finalized: boolean;
  cleaned: boolean;
}

interface ScheduledInterval {
  start: number;
  end: number;
}

interface NoiseLayerOptions {
  at: number;
  duration: number;
  attack?: number;
  gain: number;
  filter: BiquadFilterType;
  frequency: number;
  q?: number;
}

interface ToneLayerOptions {
  at: number;
  duration: number;
  attack?: number;
  gain: number;
  type: OscillatorType;
  frequencyStart: number;
  frequencyEnd?: number;
}

interface FootstepProfile {
  filter: BiquadFilterType;
  frequency: number;
  q: number;
  duration: number;
  noiseGain: number;
  toneHz: number;
  toneGain: number;
}

const DEFAULT_LISTENER: ListenerPose = {
  position: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
};

const FOOTSTEP_PROFILES: Record<SurfaceKind, FootstepProfile> = {
  concrete: {
    filter: 'bandpass', frequency: 1650, q: 0.8, duration: 0.085,
    noiseGain: 0.38, toneHz: 126, toneGain: 0.22,
  },
  metal: {
    filter: 'highpass', frequency: 2600, q: 0.7, duration: 0.075,
    noiseGain: 0.34, toneHz: 205, toneGain: 0.24,
  },
  wood: {
    filter: 'bandpass', frequency: 980, q: 1.1, duration: 0.1,
    noiseGain: 0.3, toneHz: 155, toneGain: 0.3,
  },
  sand: {
    filter: 'lowpass', frequency: 1050, q: 0.5, duration: 0.15,
    noiseGain: 0.38, toneHz: 82, toneGain: 0.1,
  },
  glass: {
    filter: 'highpass', frequency: 4100, q: 0.8, duration: 0.095,
    noiseGain: 0.29, toneHz: 620, toneGain: 0.12,
  },
  flesh: {
    filter: 'lowpass', frequency: 720, q: 0.6, duration: 0.095,
    noiseGain: 0.23, toneHz: 74, toneGain: 0.15,
  },
  foliage: {
    filter: 'bandpass', frequency: 2800, q: 0.55, duration: 0.17,
    noiseGain: 0.35, toneHz: 96, toneGain: 0.07,
  },
  water: {
    filter: 'highpass', frequency: 1700, q: 0.5, duration: 0.16,
    noiseGain: 0.37, toneHz: 430, toneGain: 0.1,
  },
  dirt: {
    filter: 'lowpass', frequency: 1350, q: 0.65, duration: 0.13,
    noiseGain: 0.36, toneHz: 92, toneGain: 0.14,
  },
  fabric: {
    filter: 'lowpass', frequency: 2300, q: 0.55, duration: 0.105,
    noiseGain: 0.2, toneHz: 112, toneGain: 0.06,
  },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const distanceBetween = (a: Vector3Like, b: Vector3Like): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const normalize = (value: Vector3Like, fallback: Vector3Like): Vector3Like => {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length < 1e-8) return { ...fallback };
  return { x: value.x / length, y: value.y / length, z: value.z / length };
};

export class ProceduralAudioEngine {
  private readonly random: DeterministicRandom;
  private readonly input: GainNode;
  private readonly outputNodes: AudioNode[] = [];
  private readonly liveSources = new Map<AudioScheduledSourceNode, () => void>();
  private readonly intervals: ScheduledInterval[] = [];
  private readonly lastFootstepVariant = new Map<SurfaceKind, number>();
  private listener: ListenerPose = {
    position: { ...DEFAULT_LISTENER.position },
    forward: { ...DEFAULT_LISTENER.forward },
    up: { ...DEFAULT_LISTENER.up },
  };
  private listenerRight: Vector3Like = { x: 1, y: 0, z: 0 };
  private disposed = false;
  private readonly stats: SynthesisDiagnostics = {
    eventsScheduled: 0,
    voicesCreated: 0,
    activeVoices: 0,
    peakActiveVoices: 0,
    sourcesCreated: 0,
    activeSources: 0,
    peakActiveSources: 0,
    peakConcurrentSources: 0,
    nodesCreated: 0,
    maximumTailSeconds: 0,
    latestScheduledEnd: 0,
  };

  constructor(
    private readonly context: BaseAudioContext,
    options: ProceduralAudioEngineOptions = {},
  ) {
    this.random = new DeterministicRandom(options.seed ?? 0x72617070);
    this.input = this.createGain();
    this.input.gain.value = 2.6;

    const master = this.createGain();
    master.gain.value = clamp(options.masterGain ?? 0.92, 0, 1);
    this.outputNodes.push(master);

    if (options.limiterEnabled ?? true) {
      const compressor = this.createWaveShaper();
      compressor.curve = this.createCompressionCurve();

      const limiter = this.createWaveShaper();
      limiter.curve = this.createLimiterCurve();
      const ceiling = this.createGain();
      ceiling.gain.value = LIMITER_OUTPUT_CEILING;

      this.input.connect(compressor);
      compressor.connect(limiter);
      limiter.connect(master);
      master.connect(ceiling);
      ceiling.connect(context.destination);
      this.outputNodes.push(compressor, limiter, ceiling);
    } else {
      this.input.connect(master);
      master.connect(context.destination);
    }
  }

  get diagnostics(): SynthesisDiagnostics {
    return { ...this.stats };
  }

  setListenerPose(pose: ListenerPose): void {
    if (
      !isFiniteVector3(pose.position)
      || !isFiniteVector3(pose.forward)
      || !isFiniteVector3(pose.up)
    ) return;

    const forward = normalize(pose.forward, DEFAULT_LISTENER.forward);
    const up = normalize(pose.up, DEFAULT_LISTENER.up);
    this.listener = {
      position: { ...pose.position },
      forward,
      up,
    };
    this.listenerRight = normalize({
      x: forward.y * up.z - forward.z * up.y,
      y: forward.z * up.x - forward.x * up.z,
      z: forward.x * up.y - forward.y * up.x,
    }, { x: 1, y: 0, z: 0 });
  }

  playWeaponFired(payload: unknown, when?: number): boolean {
    if (this.disposed || !payload || typeof payload !== 'object') return false;
    const shot = payload as Partial<WeaponFiredPayload>;
    if (!isFiniteVector3(shot.origin)) return false;

    const requestedAt = this.resolveTime(when);
    const distance = distanceBetween(shot.origin, this.listener.position);
    const at = requestedAt + this.propagationDelay(distance);
    const far = clamp((distance - 10) / 55, 0, 1);
    const pitch = this.random.range(0.94, 1.065);
    const energy = this.random.range(0.92, 1.04);
    const end = at + 0.38;
    const voice = this.createVoice(shot.origin, energy);

    this.addNoise(voice, {
      at,
      duration: this.random.range(0.012, 0.018),
      attack: 0.0008,
      gain: 0.72 * (1 - 0.58 * far),
      filter: 'highpass',
      frequency: 4300 - 2100 * far,
      q: 0.65,
    });
    this.addTone(voice, {
      at,
      duration: 0.13 + 0.035 * far,
      attack: 0.0015,
      gain: 0.46 * (1 - 0.22 * far),
      type: 'triangle',
      frequencyStart: 190 * pitch,
      frequencyEnd: 72 * pitch,
    });
    this.addTone(voice, {
      at: at + 0.004,
      duration: 0.28 + 0.045 * far,
      attack: 0.004,
      gain: 0.32 * (1 + 0.12 * far),
      type: 'sine',
      frequencyStart: 82 * pitch,
      frequencyEnd: 42 * pitch,
    });
    this.addNoise(voice, {
      at: at + 0.018,
      duration: 0.31 + 0.045 * far,
      attack: 0.008,
      gain: 0.2 * (1 + 0.38 * far),
      filter: 'lowpass',
      frequency: 2700 - 1450 * far,
      q: 0.55,
    });

    this.finalizeVoice(voice);
    this.recordEvent(at, end);
    return true;
  }

  playBulletImpact(payload: unknown, when?: number): boolean {
    if (this.disposed || !payload || typeof payload !== 'object') return false;
    const impact = payload as Partial<BulletImpactPayload>;
    if (!isFiniteVector3(impact.point) || !isSurfaceKind(impact.material)) {
      return false;
    }

    const requestedAt = this.resolveTime(when);
    const distance = distanceBetween(impact.point, this.listener.position);
    const at = requestedAt + this.propagationDelay(distance);
    const pitch = this.random.range(0.92, 1.08);
    const energy = this.random.range(0.9, 1.06);
    const voice = this.createVoice(impact.point, energy * 0.86);
    const end = this.synthesizeImpact(voice, impact.material, at, pitch);

    this.finalizeVoice(voice);
    this.recordEvent(at, end);
    return true;
  }

  playFootstep(payload: unknown, when?: number): boolean {
    if (this.disposed || !payload || typeof payload !== 'object') return false;
    const footstep = payload as Partial<FootstepPayload>;
    const loud = footstep.loud;
    if (
      !isFiniteVector3(footstep.position)
      || !isSurfaceKind(footstep.surface)
      || typeof loud !== 'number'
      || !Number.isFinite(loud)
    ) return false;

    const at = this.resolveTime(when);
    const surface = footstep.surface;
    const profile = FOOTSTEP_PROFILES[surface];
    const variant = this.nextFootstepVariant(surface);
    const pitchVariants = [0.93, 1.055, 0.975, 1.105] as const;
    const durationVariants = [1.06, 0.94, 1.0, 0.89] as const;
    const pitch = pitchVariants[variant] * this.random.range(0.985, 1.015);
    const duration = profile.duration * durationVariants[variant];
    const loudness = clamp(loud, 0.05, 1.5);
    const voice = this.createVoice(footstep.position, 0.68 * loudness);

    this.addNoise(voice, {
      at,
      duration,
      attack: 0.002,
      gain: profile.noiseGain,
      filter: profile.filter,
      frequency: profile.frequency * pitch,
      q: profile.q,
    });
    this.addTone(voice, {
      at: at + 0.003,
      duration: Math.min(0.105, duration * 0.8),
      attack: 0.002,
      gain: profile.toneGain,
      type: 'triangle',
      frequencyStart: profile.toneHz * pitch,
      frequencyEnd: profile.toneHz * pitch * 0.7,
    });

    if (surface === 'metal') {
      this.addTone(voice, {
        at: at + 0.009,
        duration: 0.14,
        attack: 0.002,
        gain: 0.11,
        type: 'sine',
        frequencyStart: 1280 * pitch,
        frequencyEnd: 1180 * pitch,
      });
    } else if (surface === 'glass') {
      this.addTone(voice, {
        at: at + 0.018,
        duration: 0.1,
        attack: 0.001,
        gain: 0.08,
        type: 'sine',
        frequencyStart: 3100 * pitch,
        frequencyEnd: 2760 * pitch,
      });
    } else if (surface === 'water') {
      this.addTone(voice, {
        at: at + 0.024,
        duration: 0.13,
        attack: 0.004,
        gain: 0.08,
        type: 'sine',
        frequencyStart: 520 * pitch,
        frequencyEnd: 760 * pitch,
      });
    } else if (surface === 'foliage') {
      this.addNoise(voice, {
        at: at + 0.026,
        duration: 0.12,
        attack: 0.01,
        gain: 0.14,
        filter: 'highpass',
        frequency: 4400 * pitch,
        q: 0.45,
      });
    }

    const end = at + Math.max(duration, 0.16);
    this.finalizeVoice(voice);
    this.recordEvent(at, end);
    return true;
  }

  playReloadStart(when?: number): boolean {
    if (this.disposed) return false;
    const at = this.resolveTime(when);
    const voice = this.createVoice(null, 0.62);

    this.addNoise(voice, {
      at,
      duration: 0.018,
      attack: 0.0005,
      gain: 0.3,
      filter: 'highpass',
      frequency: 2300,
      q: 0.8,
    });
    this.addTone(voice, {
      at: at + 0.003,
      duration: 0.045,
      attack: 0.001,
      gain: 0.24,
      type: 'square',
      frequencyStart: 410,
      frequencyEnd: 230,
    });
    this.addNoise(voice, {
      at: at + 0.052,
      duration: 0.035,
      attack: 0.002,
      gain: 0.16,
      filter: 'bandpass',
      frequency: 1450,
      q: 1.3,
    });

    const end = at + 0.095;
    this.finalizeVoice(voice);
    this.recordEvent(at, end);
    return true;
  }

  playReloadEnd(when?: number): boolean {
    if (this.disposed) return false;
    const at = this.resolveTime(when);
    const voice = this.createVoice(null, 0.7);

    this.addNoise(voice, {
      at,
      duration: 0.024,
      attack: 0.0007,
      gain: 0.36,
      filter: 'bandpass',
      frequency: 1800,
      q: 0.85,
    });
    this.addTone(voice, {
      at: at + 0.002,
      duration: 0.07,
      attack: 0.001,
      gain: 0.3,
      type: 'triangle',
      frequencyStart: 260,
      frequencyEnd: 115,
    });
    this.addNoise(voice, {
      at: at + 0.064,
      duration: 0.021,
      attack: 0.0006,
      gain: 0.25,
      filter: 'highpass',
      frequency: 2900,
      q: 0.75,
    });
    this.addTone(voice, {
      at: at + 0.067,
      duration: 0.065,
      attack: 0.001,
      gain: 0.12,
      type: 'sine',
      frequencyStart: 980,
      frequencyEnd: 760,
    });

    const end = at + 0.14;
    this.finalizeVoice(voice);
    this.recordEvent(at, end);
    return true;
  }

  playDamage(payload: unknown, when?: number): boolean {
    if (this.disposed || !payload || typeof payload !== 'object') return false;
    const damage = payload as Partial<DamagePayload>;
    const amount = damage.amount;
    if (
      !isFiniteVector3(damage.point)
      || typeof amount !== 'number'
      || !Number.isFinite(amount)
    ) {
      return false;
    }

    const at = this.resolveTime(when);
    const severity = clamp(amount / 100, 0.12, 1);
    const voice = this.createVoice(damage.point, 0.42 + severity * 0.2);
    this.addNoise(voice, {
      at,
      duration: 0.075 + severity * 0.035,
      attack: 0.0015,
      gain: 0.24 + severity * 0.08,
      filter: 'bandpass',
      frequency: 1150 - severity * 300,
      q: 0.8,
    });
    this.addTone(voice, {
      at: at + 0.002,
      duration: 0.13 + severity * 0.05,
      attack: 0.004,
      gain: 0.2 + severity * 0.08,
      type: 'sine',
      frequencyStart: 105 - severity * 15,
      frequencyEnd: 54,
    });
    if (damage.lethal === true) {
      this.addTone(voice, {
        at: at + 0.035,
        duration: 0.17,
        attack: 0.012,
        gain: 0.09,
        type: 'triangle',
        frequencyStart: 180,
        frequencyEnd: 72,
      });
    }

    const end = at + 0.23;
    this.finalizeVoice(voice);
    this.recordEvent(at, end);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const [source, finish] of [...this.liveSources]) {
      try {
        source.stop(this.context.currentTime);
      } catch {
        // A source that already ended is finalized below.
      }
      finish();
    }

    this.input.disconnect();
    for (const node of this.outputNodes) node.disconnect();
  }

  private synthesizeImpact(
    voice: Voice,
    surface: SurfaceKind,
    at: number,
    pitch: number,
  ): number {
    switch (surface) {
      case 'metal':
        this.addNoise(voice, {
          at, duration: 0.03, attack: 0.0005, gain: 0.42,
          filter: 'highpass', frequency: 4800 * pitch, q: 0.75,
        });
        this.addTone(voice, {
          at: at + 0.002, duration: 0.3, attack: 0.001, gain: 0.25,
          type: 'sine', frequencyStart: 1780 * pitch, frequencyEnd: 1540 * pitch,
        });
        this.addTone(voice, {
          at: at + 0.004, duration: 0.21, attack: 0.001, gain: 0.14,
          type: 'sine', frequencyStart: 2870 * pitch, frequencyEnd: 2600 * pitch,
        });
        return at + 0.31;

      case 'concrete':
        this.addNoise(voice, {
          at, duration: 0.055, attack: 0.0007, gain: 0.48,
          filter: 'bandpass', frequency: 2450 * pitch, q: 0.65,
        });
        this.addNoise(voice, {
          at: at + 0.008, duration: 0.19, attack: 0.006, gain: 0.2,
          filter: 'lowpass', frequency: 540 * pitch, q: 0.55,
        });
        this.addTone(voice, {
          at, duration: 0.075, attack: 0.001, gain: 0.2,
          type: 'triangle', frequencyStart: 165 * pitch, frequencyEnd: 88 * pitch,
        });
        return at + 0.21;

      case 'wood':
        this.addNoise(voice, {
          at, duration: 0.045, attack: 0.001, gain: 0.29,
          filter: 'bandpass', frequency: 1300 * pitch, q: 1.1,
        });
        this.addTone(voice, {
          at, duration: 0.14, attack: 0.0015, gain: 0.4,
          type: 'triangle', frequencyStart: 330 * pitch, frequencyEnd: 175 * pitch,
        });
        this.addTone(voice, {
          at: at + 0.003, duration: 0.12, attack: 0.002, gain: 0.14,
          type: 'sine', frequencyStart: 118 * pitch, frequencyEnd: 82 * pitch,
        });
        return at + 0.15;

      case 'sand':
        this.addNoise(voice, {
          at, duration: 0.18, attack: 0.006, gain: 0.4,
          filter: 'lowpass', frequency: 1150 * pitch, q: 0.45,
        });
        this.addNoise(voice, {
          at: at + 0.012, duration: 0.12, attack: 0.012, gain: 0.16,
          filter: 'bandpass', frequency: 330 * pitch, q: 0.65,
        });
        return at + 0.2;

      case 'glass':
        this.addNoise(voice, {
          at, duration: 0.035, attack: 0.0004, gain: 0.34,
          filter: 'highpass', frequency: 5900 * pitch, q: 0.7,
        });
        this.addTone(voice, {
          at: at + 0.002, duration: 0.31, attack: 0.001, gain: 0.15,
          type: 'sine', frequencyStart: 2750 * pitch, frequencyEnd: 2530 * pitch,
        });
        this.addTone(voice, {
          at: at + 0.011, duration: 0.23, attack: 0.001, gain: 0.12,
          type: 'sine', frequencyStart: 4260 * pitch, frequencyEnd: 3940 * pitch,
        });
        this.addTone(voice, {
          at: at + 0.026, duration: 0.17, attack: 0.001, gain: 0.08,
          type: 'sine', frequencyStart: 6180 * pitch, frequencyEnd: 5750 * pitch,
        });
        return at + 0.33;

      case 'flesh':
        this.addNoise(voice, {
          at, duration: 0.085, attack: 0.002, gain: 0.26,
          filter: 'lowpass', frequency: 820 * pitch, q: 0.55,
        });
        this.addTone(voice, {
          at, duration: 0.13, attack: 0.003, gain: 0.2,
          type: 'sine', frequencyStart: 96 * pitch, frequencyEnd: 57 * pitch,
        });
        return at + 0.15;

      case 'foliage':
        this.addNoise(voice, {
          at, duration: 0.18, attack: 0.005, gain: 0.34,
          filter: 'bandpass', frequency: 2600 * pitch, q: 0.5,
        });
        this.addNoise(voice, {
          at: at + 0.035, duration: 0.13, attack: 0.012, gain: 0.16,
          filter: 'highpass', frequency: 4700 * pitch, q: 0.45,
        });
        return at + 0.2;

      case 'water':
        this.addNoise(voice, {
          at, duration: 0.14, attack: 0.002, gain: 0.38,
          filter: 'highpass', frequency: 1750 * pitch, q: 0.5,
        });
        this.addNoise(voice, {
          at: at + 0.012, duration: 0.2, attack: 0.008, gain: 0.18,
          filter: 'lowpass', frequency: 720 * pitch, q: 0.6,
        });
        this.addTone(voice, {
          at: at + 0.025, duration: 0.18, attack: 0.006, gain: 0.13,
          type: 'sine', frequencyStart: 610 * pitch, frequencyEnd: 980 * pitch,
        });
        return at + 0.22;

      case 'dirt':
        this.addNoise(voice, {
          at, duration: 0.14, attack: 0.003, gain: 0.37,
          filter: 'lowpass', frequency: 1380 * pitch, q: 0.6,
        });
        this.addNoise(voice, {
          at: at + 0.008, duration: 0.085, attack: 0.004, gain: 0.17,
          filter: 'bandpass', frequency: 480 * pitch, q: 0.85,
        });
        this.addTone(voice, {
          at, duration: 0.09, attack: 0.002, gain: 0.11,
          type: 'triangle', frequencyStart: 122 * pitch, frequencyEnd: 72 * pitch,
        });
        return at + 0.16;

      case 'fabric':
        this.addNoise(voice, {
          at, duration: 0.1, attack: 0.003, gain: 0.23,
          filter: 'lowpass', frequency: 2450 * pitch, q: 0.5,
        });
        this.addNoise(voice, {
          at: at + 0.006, duration: 0.075, attack: 0.006, gain: 0.12,
          filter: 'bandpass', frequency: 930 * pitch, q: 0.7,
        });
        return at + 0.12;
    }
  }

  private addNoise(voice: Voice, options: NoiseLayerOptions): void {
    const duration = Math.max(0.006, options.duration);
    const sampleCount = Math.max(
      2,
      Math.ceil((duration + 0.008) * this.context.sampleRate),
    );
    const buffer = this.context.createBuffer(1, sampleCount, this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = this.random.next() * 2 - 1;
    }

    const source = this.createBufferSource();
    source.buffer = buffer;
    const filter = this.createBiquadFilter();
    filter.type = options.filter;
    filter.frequency.setValueAtTime(
      clamp(options.frequency, 30, this.context.sampleRate * 0.47),
      options.at,
    );
    filter.Q.setValueAtTime(options.q ?? 0.7, options.at);
    const envelope = this.createGain();
    this.applyEnvelope(
      envelope.gain,
      options.at,
      options.attack ?? 0.001,
      options.at + duration,
      options.gain,
    );

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(voice.nodes[0]);
    const end = options.at + duration + 0.004;
    this.trackSource(source, voice, options.at, end, [filter, envelope]);
    source.start(options.at);
    source.stop(end);
  }

  private addTone(voice: Voice, options: ToneLayerOptions): void {
    const duration = Math.max(0.008, options.duration);
    const oscillator = this.createOscillator();
    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(
      Math.max(20, options.frequencyStart),
      options.at,
    );
    if (options.frequencyEnd !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.frequencyEnd),
        options.at + duration,
      );
    }

    const envelope = this.createGain();
    this.applyEnvelope(
      envelope.gain,
      options.at,
      options.attack ?? 0.002,
      options.at + duration,
      options.gain,
    );
    oscillator.connect(envelope);
    envelope.connect(voice.nodes[0]);
    const end = options.at + duration + 0.004;
    this.trackSource(oscillator, voice, options.at, end, [envelope]);
    oscillator.start(options.at);
    oscillator.stop(end);
  }

  private applyEnvelope(
    parameter: AudioParam,
    at: number,
    attack: number,
    end: number,
    gain: number,
  ): void {
    const attackEnd = Math.min(end - 0.001, at + Math.max(0.0005, attack));
    parameter.setValueAtTime(0.0001, at);
    parameter.exponentialRampToValueAtTime(Math.max(0.0001, gain), attackEnd);
    parameter.exponentialRampToValueAtTime(0.0001, end);
    parameter.setValueAtTime(0, end + 0.002);
  }

  private createVoice(position: Vector3Like | null, intensity: number): Voice {
    const gain = this.createGain();
    const panner = this.createStereoPanner();
    let attenuation = 1;
    let pan = 0;

    if (position) {
      const dx = position.x - this.listener.position.x;
      const dy = position.y - this.listener.position.y;
      const dz = position.z - this.listener.position.z;
      const distance = Math.hypot(dx, dy, dz);
      attenuation = distance <= 1
        ? 1
        : Math.max(0.035, 1 / (1 + Math.pow((distance - 1) / 11, 1.28)));
      if (distance > 1e-6) {
        pan = clamp(
          (dx * this.listenerRight.x
            + dy * this.listenerRight.y
            + dz * this.listenerRight.z) / distance,
          -1,
          1,
        );
      }
    }

    gain.gain.value = attenuation * intensity;
    panner.pan.value = pan;
    gain.connect(panner);
    panner.connect(this.input);

    this.stats.voicesCreated++;
    this.stats.activeVoices++;
    this.stats.peakActiveVoices = Math.max(
      this.stats.peakActiveVoices,
      this.stats.activeVoices,
    );
    return {
      nodes: [gain, panner],
      remainingSources: 0,
      finalized: false,
      cleaned: false,
    };
  }

  private finalizeVoice(voice: Voice): void {
    voice.finalized = true;
    if (voice.remainingSources === 0) this.cleanupVoice(voice);
  }

  private cleanupVoice(voice: Voice): void {
    if (voice.cleaned) return;
    voice.cleaned = true;
    for (const node of voice.nodes) node.disconnect();
    this.stats.activeVoices = Math.max(0, this.stats.activeVoices - 1);
  }

  private trackSource(
    source: AudioScheduledSourceNode,
    voice: Voice,
    start: number,
    end: number,
    layerNodes: AudioNode[],
  ): void {
    this.pruneIntervals();
    let concurrent = 1;
    for (const interval of this.intervals) {
      if (interval.start < end && interval.end > start) concurrent++;
    }
    this.intervals.push({ start, end });
    this.stats.peakConcurrentSources = Math.max(
      this.stats.peakConcurrentSources,
      concurrent,
    );

    voice.remainingSources++;
    this.stats.sourcesCreated++;
    this.stats.activeSources++;
    this.stats.peakActiveSources = Math.max(
      this.stats.peakActiveSources,
      this.stats.activeSources,
    );

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.liveSources.delete(source);
      source.disconnect();
      for (const node of layerNodes) node.disconnect();
      this.stats.activeSources = Math.max(0, this.stats.activeSources - 1);
      voice.remainingSources = Math.max(0, voice.remainingSources - 1);
      if (voice.finalized && voice.remainingSources === 0) {
        this.cleanupVoice(voice);
      }
    };

    source.onended = finish;
    this.liveSources.set(source, finish);
  }

  private pruneIntervals(): void {
    const now = this.context.currentTime;
    let write = 0;
    for (const interval of this.intervals) {
      if (interval.end > now) this.intervals[write++] = interval;
    }
    this.intervals.length = write;
  }

  private nextFootstepVariant(surface: SurfaceKind): number {
    const previous = this.lastFootstepVariant.get(surface);
    let next: number;
    if (previous === undefined) {
      next = this.random.integer(4);
    } else {
      const offset = 1 + this.random.integer(3);
      next = (previous + offset) % 4;
    }
    this.lastFootstepVariant.set(surface, next);
    return next;
  }

  private propagationDelay(distance: number): number {
    if (distance < 3) return 0;
    return Math.min(0.08, distance / 343);
  }

  private resolveTime(when?: number): number {
    const requested = when ?? this.context.currentTime + 0.003;
    return Math.max(this.context.currentTime, requested);
  }

  private recordEvent(start: number, end: number): void {
    this.stats.eventsScheduled++;
    this.stats.maximumTailSeconds = Math.max(
      this.stats.maximumTailSeconds,
      end - start,
    );
    this.stats.latestScheduledEnd = Math.max(this.stats.latestScheduledEnd, end);
  }

  private createLimiterCurve(): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(new ArrayBuffer(4097 * Float32Array.BYTES_PER_ELEMENT));
    const drive = 2.35;
    const normalization = Math.tanh(drive);
    for (let i = 0; i < curve.length; i++) {
      const x = i / (curve.length - 1) * 2 - 1;
      curve[i] = 0.91 * Math.tanh(drive * x) / normalization;
    }
    return curve;
  }

  private createCompressionCurve(): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(new ArrayBuffer(4097 * Float32Array.BYTES_PER_ELEMENT));
    const threshold = 0.4;
    for (let i = 0; i < curve.length; i++) {
      const input = i / (curve.length - 1) * 2 - 1;
      const magnitude = Math.abs(input);
      const compressed = magnitude <= threshold
        ? magnitude
        : threshold + (1 - Math.exp(-(magnitude - threshold) * 2)) * 0.5;
      curve[i] = Math.sign(input) * compressed;
    }
    return curve;
  }

  private createGain(): GainNode {
    this.stats.nodesCreated++;
    return this.context.createGain();
  }

  private createStereoPanner(): StereoPannerNode {
    this.stats.nodesCreated++;
    return this.context.createStereoPanner();
  }

  private createBiquadFilter(): BiquadFilterNode {
    this.stats.nodesCreated++;
    return this.context.createBiquadFilter();
  }

  private createBufferSource(): AudioBufferSourceNode {
    this.stats.nodesCreated++;
    return this.context.createBufferSource();
  }

  private createOscillator(): OscillatorNode {
    this.stats.nodesCreated++;
    return this.context.createOscillator();
  }

  private createWaveShaper(): WaveShaperNode {
    this.stats.nodesCreated++;
    return this.context.createWaveShaper();
  }
}
