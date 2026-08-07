import {
  Events,
  type EngineContext,
  type EventBus,
} from '../../core/contracts.js';
import {
  analyzePcm,
  canonicalizePcm16,
  channelRms,
  encodeWav16,
  sha256Hex,
  type PcmAnalysis,
} from '../analysis.js';
import {
  AudioSystem,
  type AudioSynthesisBackend,
} from '../AudioSystem.js';
import {
  LIMITER_OUTPUT_CEILING,
  ProceduralAudioEngine,
} from '../ProceduralAudioEngine.js';
import {
  AUDIO_SURFACES,
  type ListenerPose,
  type SynthesisDiagnostics,
  type Vector3Like,
} from '../types.js';

const SAMPLE_RATE = 24_000;
const CANONICAL_PCM_BITS = 10;
const DEFAULT_SEED = 0x72617070;
const DEFAULT_LISTENER = {
  position: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
};

interface RenderResult {
  name: string;
  pcm: Float32Array[];
  wav: Uint8Array;
  wavSha256: string;
  rawSamplePeak: number;
  analysis: PcmAnalysis;
  diagnostics: SynthesisDiagnostics;
  scheduleMilliseconds: number;
  renderMilliseconds: number;
  listenerUpdateMicroseconds: number | null;
  listenerUpdateNodeDelta: number;
}

interface SerializableEvidence {
  status: 'complete';
  report: Record<string, unknown>;
  wavs: Record<string, string>;
}

type EvidenceState =
  | { status: 'idle' | 'running' }
  | SerializableEvidence
  | { status: 'failed'; error: string };

declare global {
  interface Window {
    __AUDIO_EVIDENCE__: EvidenceState;
  }
}

class HarnessBus implements EventBus {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on<T = unknown>(event: string, fn: (payload: T) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    const listener = fn as (payload: unknown) => void;
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  emit<T = unknown>(event: string, payload?: T): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

class HarnessSynthesis implements AudioSynthesisBackend {
  readonly diagnostics: SynthesisDiagnostics = {
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
  disposed = false;

  setListenerPose(pose: ListenerPose): void {
    void pose;
  }

  playWeaponFired(payload: unknown, when?: number): boolean {
    void payload;
    void when;
    return true;
  }

  playBulletImpact(payload: unknown, when?: number): boolean {
    void payload;
    void when;
    return true;
  }

  playFootstep(payload: unknown, when?: number): boolean {
    void payload;
    void when;
    return true;
  }

  playReloadStart(when?: number): boolean {
    void when;
    return true;
  }

  playReloadEnd(when?: number): boolean {
    void when;
    return true;
  }

  playDamage(payload: unknown, when?: number): boolean {
    void payload;
    void when;
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

type HarnessContextState = AudioContextState | 'interrupted';

class ControlledAudioContext {
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();
  private pendingResume: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private stateValue: HarnessContextState;
  resumeCalls = 0;
  closeCalls = 0;

  constructor(
    initialState: HarnessContextState,
    private readonly resumeMode: 'immediate' | 'pending',
  ) {
    this.stateValue = initialState;
  }

  get state(): AudioContextState {
    return this.stateValue as AudioContextState;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeMode === 'immediate') {
      this.transition('running');
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingResume = { resolve, reject };
    });
  }

  close(): Promise<void> {
    this.closeCalls++;
    this.transition('closed');
    return Promise.resolve();
  }

  transition(state: HarnessContextState): void {
    this.stateValue = state;
    const event = new Event('statechange');
    for (const listener of [...this.listeners]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  rejectResume(error: Error): void {
    const pending = this.pendingResume;
    this.pendingResume = null;
    pending?.reject(error);
  }
}

window.__AUDIO_EVIDENCE__ = { status: 'idle' };

const runButton = document.getElementById('run') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLDivElement;
runButton.addEventListener('click', () => {
  runButton.disabled = true;
  status.textContent = 'Rendering deterministic evidence…';
  window.__AUDIO_EVIDENCE__ = { status: 'running' };
  void buildEvidence()
    .then((evidence) => {
      window.__AUDIO_EVIDENCE__ = evidence;
      status.textContent = 'Evidence complete.';
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      window.__AUDIO_EVIDENCE__ = { status: 'failed', error: message };
      status.textContent = `Evidence failed: ${message}`;
    });
}, { once: true });

async function buildEvidence(): Promise<SerializableEvidence> {
  const assertions: string[] = [];
  const armPolicy = await verifyArmPolicy();
  check(
    armPolicy.contextsBeforeGesture === 0
      && armPolicy.droppedBeforeGesture === 1
      && armPolicy.armed,
    'autoplay gate creates no context before arm and drops pre-arm events',
    assertions,
  );
  const lifecycle = await verifyAudioLifecycle();
  check(
    lifecycle.initialArm
      && lifecycle.interruptedState === 'interrupted'
      && lifecycle.retryArm
      && lifecycle.resumeCalls === 2,
    'iOS interrupted state remains resumable and arm retry succeeds',
    assertions,
  );
  check(
    lifecycle.raceState === 'closed'
      && !lifecycle.raceArmResult
      && lifecycle.raceLastError === null
      && lifecycle.raceBackendDisposed,
    'dispose wins a pending resume race without obsolete arm state mutation',
    assertions,
  );

  const near = await renderShot('shot-near', DEFAULT_SEED, { x: 0, y: 0, z: -2 });
  const nearRepeat = await renderShot(
    'shot-near-repeat',
    DEFAULT_SEED,
    { x: 0, y: 0, z: -2 },
  );
  const alternateSeed = await renderShot(
    'shot-near-alternate-seed',
    DEFAULT_SEED + 1,
    { x: 0, y: 0, z: -2 },
  );
  const far = await renderShot(
    'shot-far',
    DEFAULT_SEED,
    { x: 18, y: 0, z: -28 },
    1,
  );

  assertNoSampleClipping(near.analysis);
  assertNoSampleClipping(far.analysis);
  check(
    near.wavSha256 === nearRepeat.wavSha256,
    'same seed produces byte-identical signed 16-bit PCM/WAV bytes',
    assertions,
  );
  check(
    near.wavSha256 !== alternateSeed.wavSha256,
    'different seed changes the rendered PCM',
    assertions,
  );
  check(
    Math.abs(near.analysis.lufsApprox - alternateSeed.analysis.lufsApprox) < 2.5,
    'different-seed loudness variation remains within 2.5 dB',
    assertions,
  );
  check(
    near.analysis.rms > far.analysis.rms * 2.2,
    'distance attenuation reduces far-shot RMS by more than 6.8 dB',
    assertions,
  );
  check(
    far.analysis.spectralCentroidHz < near.analysis.spectralCentroidHz,
    'far-shot spectral centroid is lower than near-shot centroid',
    assertions,
  );

  const impacts: Record<string, RenderResult> = {};
  for (const surface of AUDIO_SURFACES) {
    const result = await renderImpact(surface);
    assertNoSampleClipping(result.analysis);
    impacts[surface] = result;
  }
  check(
    Object.values(impacts).every(
      (result) => result.analysis.durationSeconds === 0.6,
    ),
    'surface comparison uses one seed and one 0.6-second analysis window',
    assertions,
  );
  const impactHashes = Object.values(impacts).map((result) => result.wavSha256);
  check(
    new Set(impactHashes).size === AUDIO_SURFACES.length,
    'every canonical surface produces a distinct impact render',
    assertions,
  );
  const centroids = Object.values(impacts)
    .map((result) => result.analysis.spectralCentroidHz);
  check(
    Math.max(...centroids) - Math.min(...centroids) > 1500,
    'surface impact spectral centroids span more than 1.5 kHz',
    assertions,
  );

  const footsteps = await renderFootsteps();
  assertNoSampleClipping(footsteps.result.analysis);
  check(
    footsteps.adjacentSegmentsDiffer,
    'deterministic footsteps avoid adjacent machine-gun repetition',
    assertions,
  );

  const stress = await renderAutomaticFire(true);
  assertNoSampleClipping(stress.result.analysis);
  check(
    stress.result.diagnostics.activeSources === 0
      && stress.result.diagnostics.activeVoices === 0,
    '30-round render releases every source and voice',
    assertions,
  );
  check(
    stress.result.diagnostics.peakConcurrentSources <= 24,
    '30-round source concurrency remains bounded',
    assertions,
  );
  check(
    stress.tailRms < 1e-5,
    '30-round render reaches a stable silent tail',
    assertions,
  );
  check(
    stress.result.listenerUpdateNodeDelta === 0,
    'listener updates allocate no Web Audio nodes',
    assertions,
  );

  const negativeControl = await renderAutomaticFire(false);
  let negativeControlFailed = false;
  try {
    assertNoSampleClipping(negativeControl.result.analysis);
  } catch {
    negativeControlFailed = true;
  }
  check(
    negativeControl.result.rawSamplePeak > 1
      && negativeControlFailed,
    'disabled-limiter raw render exceeds sample full scale',
    assertions,
  );

  const spatial = await renderSpatialCheck();
  check(
    spatial.rightRms > spatial.leftRms * 1.4,
    'positive listener-right position pans measurably to the right channel',
    assertions,
  );
  const eventCoverage = await renderReloadAndDamageCoverage();
  assertNoSampleClipping(eventCoverage.analysis);
  check(
    eventCoverage.diagnostics.eventsScheduled === 3
      && eventCoverage.diagnostics.activeSources === 0,
    'reload bookends and restrained damage cue render and clean up',
    assertions,
  );

  const wavResults: RenderResult[] = [
    near,
    far,
    ...AUDIO_SURFACES.map((surface) => impacts[surface]),
    footsteps.result,
    stress.result,
    negativeControl.result,
  ];
  const wavs: Record<string, string> = {};
  for (const result of wavResults) {
    wavs[`${result.name}.wav`] = toBase64(result.wav);
  }

  const nodesPerShot = stress.result.diagnostics.nodesCreated / 30;
  const report: Record<string, unknown> = {
    formatVersion: 2,
    proceduralOnly: true,
    sampleRate: SAMPLE_RATE,
    seed: DEFAULT_SEED,
    deterministicPcmFormat:
      `${CANONICAL_PCM_BITS}-bit canonical quantization in signed 16-bit little-endian PCM`,
    limiterOutputCeilingLinear: LIMITER_OUTPUT_CEILING,
    assertions,
    armPolicy,
    lifecycle,
    shots: {
      near: summarize(near),
      far: summarize(far),
      alternateSeed: summarize(alternateSeed),
    },
    impacts: Object.fromEntries(
      AUDIO_SURFACES.map((surface) => [surface, summarize(impacts[surface])]),
    ),
    surfaceComparison: {
      seed: DEFAULT_SEED,
      durationSeconds: 0.6,
      eventTimeSeconds: 0.035,
      point: { x: 0, y: 0, z: -2.5 },
    },
    footsteps: {
      ...summarize(footsteps.result),
      segmentHashes: footsteps.segmentHashes,
    },
    automaticFire30: {
      ...summarize(stress.result),
      rounds: 30,
      roundsPerMinute: 900,
      tailRms: rounded(stress.tailRms),
      nodesPerShot: rounded(nodesPerShot),
    },
    disabledLimiterNegativeControl: summarize(negativeControl.result),
    spatial: {
      leftRms: rounded(spatial.leftRms),
      rightRms: rounded(spatial.rightRms),
      rightToLeftRatio: rounded(spatial.rightRms / spatial.leftRms),
    },
    reloadAndDamageCoverage: summarize(eventCoverage),
    cpu: {
      scheduleMillisecondsPerShot: rounded(
        stress.result.scheduleMilliseconds / 30,
      ),
      listenerUpdateMicroseconds: rounded(
        stress.result.listenerUpdateMicroseconds ?? 0,
      ),
      offlineRenderMilliseconds: rounded(stress.result.renderMilliseconds),
      offlineRenderToRealtimeRatio: rounded(
        stress.result.renderMilliseconds
          / (stress.result.analysis.durationSeconds * 1000),
      ),
    },
    gpu: {
      webglResourcesCreated: 0,
      renderPathChanged: false,
      note: 'The subsystem creates Web Audio nodes only and never enters the renderer.',
    },
    metricNotes: {
      standardsTruePeak: 'Added by the Node runner using FFmpeg EBU R128 peak=true.',
      canonicalPcm:
        `${CANONICAL_PCM_BITS}-bit canonical quantization removes cross-process ±1 PCM16 LSB summation variance before every reported PCM metric.`,
      lufsApprox: 'mean-square LUFS approximation without K-weighting or gating',
      energyBandsHz: {
        sub: '0-120',
        body: '120-500',
        mid: '500-2000',
        presence: '2000-8000',
        air: '8000-Nyquist',
      },
    },
  };

  return { status: 'complete', report, wavs };
}

async function renderShot(
  name: string,
  seed: number,
  origin: Vector3Like,
  durationSeconds = 0.72,
): Promise<RenderResult> {
  return renderScenario(name, durationSeconds, 1, seed, true, (engine) => {
    engine.playWeaponFired(weaponPayload(origin), 0.035);
  });
}

async function renderImpact(surface: typeof AUDIO_SURFACES[number]): Promise<RenderResult> {
  return renderScenario(
    `impact-${surface}`,
    0.6,
    1,
    DEFAULT_SEED,
    true,
    (engine) => {
      engine.playBulletImpact({
        point: { x: 0, y: 0, z: -2.5 },
        normal: { x: 0, y: 1, z: 0 },
        material: surface,
        distance: 12,
      }, 0.035);
    },
  );
}

async function renderFootsteps(): Promise<{
  result: RenderResult;
  segmentHashes: string[];
  adjacentSegmentsDiffer: boolean;
}> {
  const times = Array.from({ length: 6 }, (_, index) => 0.07 + index * 0.36);
  const result = await renderScenario(
    'footsteps-concrete',
    2.35,
    1,
    DEFAULT_SEED,
    true,
    (engine) => {
      for (const at of times) {
        engine.playFootstep({
          position: { x: 0.3, y: 0, z: -1.2 },
          surface: 'concrete',
          loud: 1,
        }, at);
      }
    },
  );

  const segmentHashes: string[] = [];
  for (const at of times) {
    const start = Math.floor(at * SAMPLE_RATE);
    const end = Math.min(result.pcm[0].length, start + Math.floor(0.24 * SAMPLE_RATE));
    const segment = result.pcm[0].slice(start, end);
    segmentHashes.push(await sha256Hex(
      encodeWav16([segment], SAMPLE_RATE, CANONICAL_PCM_BITS),
    ));
  }
  return {
    result,
    segmentHashes,
    adjacentSegmentsDiffer: segmentHashes.every(
      (hash, index) => index === 0 || hash !== segmentHashes[index - 1],
    ),
  };
}

async function renderAutomaticFire(limiterEnabled: boolean): Promise<{
  result: RenderResult;
  tailRms: number;
}> {
  const interval = 60 / 900;
  const duration = 2.9;
  const result = await renderScenario(
    limiterEnabled ? 'automatic-30' : 'automatic-30-no-limiter',
    duration,
    1,
    DEFAULT_SEED,
    limiterEnabled,
    (engine) => {
      for (let round = 0; round < 30; round++) {
        engine.playWeaponFired(
          weaponPayload({ x: 0, y: 0, z: -2 }),
          0.04 + round * interval,
        );
      }
    },
    true,
  );
  const tailStart = Math.floor((duration - 0.25) * SAMPLE_RATE);
  return {
    result,
    tailRms: channelRms(result.pcm[0], tailStart),
  };
}

async function renderSpatialCheck(): Promise<{
  leftRms: number;
  rightRms: number;
}> {
  const result = await renderScenario(
    'spatial-right',
    0.72,
    2,
    DEFAULT_SEED,
    true,
    (engine) => {
      engine.playWeaponFired(
        weaponPayload({ x: 8, y: 0, z: -4 }),
        0.035,
      );
    },
  );
  return {
    leftRms: channelRms(result.pcm[0]),
    rightRms: channelRms(result.pcm[1]),
  };
}

async function renderReloadAndDamageCoverage(): Promise<RenderResult> {
  return renderScenario(
    'reload-and-damage',
    1,
    1,
    DEFAULT_SEED,
    true,
    (engine) => {
      engine.playReloadStart(0.05);
      engine.playReloadEnd(0.34);
      engine.playDamage({
        id: 'evidence-target',
        amount: 35,
        point: { x: -1, y: 0, z: -2 },
        direction: { x: 0, y: 0, z: 1 },
        lethal: false,
      }, 0.62);
    },
  );
}

async function renderScenario(
  name: string,
  durationSeconds: number,
  channelCount: number,
  seed: number,
  limiterEnabled: boolean,
  schedule: (engine: ProceduralAudioEngine) => void,
  measureListenerUpdates = false,
): Promise<RenderResult> {
  const frameCount = Math.ceil(durationSeconds * SAMPLE_RATE);
  const context = new OfflineAudioContext(channelCount, frameCount, SAMPLE_RATE);
  const engine = new ProceduralAudioEngine(context, {
    seed,
    limiterEnabled,
    masterGain: 0.92,
  });
  engine.setListenerPose(DEFAULT_LISTENER);

  let listenerUpdateMicroseconds: number | null = null;
  let listenerUpdateNodeDelta = 0;
  if (measureListenerUpdates) {
    const iterations = 20_000;
    const nodesBefore = engine.diagnostics.nodesCreated;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      engine.setListenerPose({
        ...DEFAULT_LISTENER,
        position: { x: (i % 7) * 0.001, y: 0, z: 0 },
      });
    }
    listenerUpdateMicroseconds = (performance.now() - start) * 1000 / iterations;
    listenerUpdateNodeDelta = engine.diagnostics.nodesCreated - nodesBefore;
    engine.setListenerPose(DEFAULT_LISTENER);
  }

  const scheduleStart = performance.now();
  schedule(engine);
  const scheduleMilliseconds = performance.now() - scheduleStart;
  const renderStart = performance.now();
  const rendered = await context.startRendering();
  const renderMilliseconds = performance.now() - renderStart;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const renderedPcm = Array.from(
    { length: rendered.numberOfChannels },
    (_, channel) => rendered.getChannelData(channel).slice(),
  );
  let rawSamplePeak = 0;
  for (const channel of renderedPcm) {
    for (const sample of channel) {
      rawSamplePeak = Math.max(rawSamplePeak, Math.abs(sample));
    }
  }
  const pcm = canonicalizePcm16(renderedPcm, CANONICAL_PCM_BITS);
  const analysis = analyzePcm(pcm, SAMPLE_RATE);
  const wav = encodeWav16(pcm, SAMPLE_RATE);
  const diagnostics = engine.diagnostics;
  engine.dispose();
  return {
    name,
    pcm,
    wav,
    wavSha256: await sha256Hex(wav),
    rawSamplePeak,
    analysis,
    diagnostics,
    scheduleMilliseconds,
    renderMilliseconds,
    listenerUpdateMicroseconds,
    listenerUpdateNodeDelta,
  };
}

async function verifyArmPolicy(): Promise<{
  contextsBeforeGesture: number;
  droppedBeforeGesture: number;
  contextsAfterGesture: number;
  armed: boolean;
}> {
  let contextsCreated = 0;
  const bus = new HarnessBus();
  const audio = new AudioSystem({
    seed: DEFAULT_SEED,
    masterGain: 0,
    contextFactory: () => {
      contextsCreated++;
      return new AudioContext({ latencyHint: 'interactive' });
    },
  });
  audio.init({ bus } as unknown as EngineContext);
  bus.emit(Events.WeaponFired, weaponPayload({ x: 0, y: 0, z: -2 }));
  const contextsBeforeGesture = contextsCreated;
  const droppedBeforeGesture = audio.status.droppedWhileUnarmed;
  const armed = await audio.arm();
  const contextsAfterGesture = contextsCreated;
  audio.dispose();
  return {
    contextsBeforeGesture,
    droppedBeforeGesture,
    contextsAfterGesture,
    armed,
  };
}

async function verifyAudioLifecycle(): Promise<{
  initialArm: boolean;
  interruptedState: string;
  retryArm: boolean;
  resumeCalls: number;
  raceState: string;
  raceArmResult: boolean;
  raceLastError: string | null;
  raceBackendDisposed: boolean;
}> {
  const interruptedContext = new ControlledAudioContext('suspended', 'immediate');
  const interruptedBackend = new HarnessSynthesis();
  const interruptedAudio = new AudioSystem({
    contextFactory: () => interruptedContext as unknown as AudioContext,
    synthesisFactory: () => interruptedBackend,
  });
  const initialArm = await interruptedAudio.arm();
  interruptedContext.transition('interrupted');
  const interruptedState = interruptedAudio.status.state;
  const retryArm = await interruptedAudio.arm();
  const resumeCalls = interruptedContext.resumeCalls;
  interruptedAudio.dispose();

  const raceContext = new ControlledAudioContext('suspended', 'pending');
  const raceBackend = new HarnessSynthesis();
  const raceAudio = new AudioSystem({
    contextFactory: () => raceContext as unknown as AudioContext,
    synthesisFactory: () => raceBackend,
  });
  const pendingArm = raceAudio.arm();
  raceAudio.dispose();
  raceContext.rejectResume(new Error('resume rejected after dispose'));
  const raceArmResult = await pendingArm;

  return {
    initialArm,
    interruptedState,
    retryArm,
    resumeCalls,
    raceState: raceAudio.status.state,
    raceArmResult,
    raceLastError: raceAudio.status.lastError,
    raceBackendDisposed: raceBackend.disposed,
  };
}

function weaponPayload(origin: Vector3Like): Record<string, unknown> {
  return {
    origin,
    direction: { x: 0, y: 0, z: -1 },
    weapon: null,
    spread: 0,
  };
}

function assertNoSampleClipping(analysis: PcmAnalysis): void {
  if (analysis.samplePeak >= 1) {
    throw new Error(`Sample clipping: peak=${analysis.samplePeak}`);
  }
}

function check(
  condition: boolean,
  label: string,
  assertions: string[],
): void {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
  assertions.push(label);
}

function summarize(result: RenderResult): Record<string, unknown> {
  return {
    wavSha256: result.wavSha256,
    analysis: {
      rawFloatSamplePeak: rounded(result.rawSamplePeak),
      samplePeak: rounded(result.analysis.samplePeak),
      rms: rounded(result.analysis.rms),
      rmsDbfs: rounded(result.analysis.rmsDbfs),
      lufsApprox: rounded(result.analysis.lufsApprox),
      crestFactorDb: rounded(result.analysis.crestFactorDb),
      durationSeconds: rounded(result.analysis.durationSeconds),
      dcOffset: rounded(result.analysis.dcOffset),
      spectralCentroidHz: rounded(result.analysis.spectralCentroidHz),
      energyBands: Object.fromEntries(
        Object.entries(result.analysis.energyBands)
          .map(([band, energy]) => [band, rounded(energy)]),
      ),
    },
    diagnostics: result.diagnostics,
    scheduleMilliseconds: rounded(result.scheduleMilliseconds),
    renderMilliseconds: rounded(result.renderMilliseconds),
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}
