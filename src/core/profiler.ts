/**
 * Frame profiler — measures the three clocks separately. — #7
 *
 * A previous instrument measured the interval between requestAnimationFrame
 * callbacks and labelled it "GPU throughput." The same frame, same code and
 * same renderer alternated between 6.5ms and 11.8ms. That value was browser
 * scheduling cadence, not GPU time, and could make an unchanged frame pass or
 * fail the 16.7ms budget.
 *
 * These clocks answer different questions and must never be collapsed:
 *
 *  - GPU: EXT_disjoint_timer_query_webgl2 around the submitted render commands.
 *  - CPU: performance.now() around simulation, presentation and command submit.
 *  - rAF: interval between callbacks — useful for spotting scheduler stalls,
 *         never used as the render-budget verdict.
 *
 * GPU results arrive asynchronously several frames later. Queries are queued,
 * polled in order, and discarded when the driver reports a disjoint event.
 * Unsupported or disjoint measurements are not estimates; the harness refuses
 * them and reports UNVERIFIED.
 */

import type * as THREE from 'three';

interface TimerQueryExtension {
  readonly QUERY_COUNTER_BITS_EXT: number;
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export interface Distribution {
  samples: number;
  median: number | null;
  p95: number | null;
  worst: number | null;
}

export interface ProfilerSnapshot {
  gpuSupported: boolean;
  gpuCounterBits: number;
  gpuDisjointCount: number;
  gpuFrameMs: Distribution;
  cpuFrameMs: Distribution;
  rafIntervalMs: Distribution;
  /** Per-frame max(CPU, GPU), paired by the frame that issued the query. */
  budgetFrameMs: Distribution;
  budgetFrameMsMedian: number | null;
  budgetFrameMsP95: number | null;
}

interface FrameToken {
  frameId: number;
  generation: number;
  cpuStart: number;
  gpuQueryStarted: boolean;
}

interface PendingGpuQuery {
  query: WebGLQuery;
  frameId: number;
  generation: number;
}

const MAX_SAMPLES = 512;
const MAX_PENDING_QUERIES = 64;

function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(3);
}

function distribution(values: readonly number[]): Distribution {
  return {
    samples: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    worst: quantile(values, 0.999),
  };
}

function pushBounded(values: number[], value: number): void {
  values.push(value);
  if (values.length > MAX_SAMPLES) values.splice(0, values.length - MAX_SAMPLES);
}

export class FrameProfiler {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExtension | null;
  private readonly counterBits: number;
  private readonly pending: PendingGpuQuery[] = [];
  private active: PendingGpuQuery | null = null;
  private currentFrame: FrameToken | null = null;
  private frameId = 0;
  private generation = 0;
  private readonly cpuByFrame = new Map<number, { value: number; generation: number }>();

  private readonly gpuMs: number[] = [];
  private readonly cpuMs: number[] = [];
  private readonly rafMs: number[] = [];
  private readonly pairedMs: number[] = [];
  private disjointCount = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext();
    // Three's public type includes WebGL1 even though r185 creates WebGL2 in
    // this project. Keep the runtime guard: a WebGL1 context has no native
    // beginQuery/endQuery and therefore cannot produce this measurement.
    this.gl = gl as WebGL2RenderingContext;
    const webgl2 = 'beginQuery' in gl && 'getQueryParameter' in gl;
    this.ext = webgl2 ? gl.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    ) as TimerQueryExtension | null : null;
    this.counterBits = this.ext
      ? Number(this.gl.getQuery(
        this.ext.TIME_ELAPSED_EXT,
        this.ext.QUERY_COUNTER_BITS_EXT,
      ))
      : 0;
  }

  get gpuSupported(): boolean { return this.ext !== null && this.counterBits > 0; }

  /**
   * Opens the CPU frame measurement and returns its start time.
   *
   * `rafIntervalMs` is passed in from the engine because only the engine knows
   * the real callback boundary. It is retained as scheduler evidence, not
   * treated as render cost.
   */
  beginFrame(rafIntervalMs: number): FrameToken {
    this.pollGpuQueries();
    if (Number.isFinite(rafIntervalMs) && rafIntervalMs >= 0) {
      pushBounded(this.rafMs, rafIntervalMs);
    }

    const token: FrameToken = {
      frameId: ++this.frameId,
      generation: this.generation,
      cpuStart: performance.now(),
      gpuQueryStarted: false,
    };
    this.currentFrame = token;
    return token;
  }

  /**
   * Opens the GPU range immediately before render submission.
   *
   * This must not begin at CPU frame start: a GPU timer query can include the
   * device sitting idle while JavaScript performs simulation before submitting
   * draw commands. That made a scheduling delay look like GPU work in the first
   * #7 implementation.
   */
  beginGpu(): void {
    if (
      this.gpuSupported
      && this.ext
      && this.currentFrame
      && this.active === null
      && this.pending.length < MAX_PENDING_QUERIES
      && this.gl.getQuery(this.ext.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) === null
    ) {
      const query = this.gl.createQuery();
      if (query) {
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
        this.currentFrame.gpuQueryStarted = true;
        this.active = {
          query,
          frameId: this.currentFrame.frameId,
          generation: this.currentFrame.generation,
        };
      }
    }
  }

  /** Closes the GPU command range after render submission. */
  endGpu(): void {
    if (this.ext && this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
  }

  /** Records synchronous whole-frame CPU execution time. */
  endFrame(token: FrameToken): void {
    const cpu = performance.now() - token.cpuStart;
    if (token.generation === this.generation) {
      pushBounded(this.cpuMs, cpu);
      if (token.gpuQueryStarted) {
        this.cpuByFrame.set(token.frameId, { value: cpu, generation: token.generation });
      }
    }
    if (this.currentFrame === token) this.currentFrame = null;
  }

  /** Clears the observation window before a controlled benchmark. */
  reset(): void {
    // Advancing the generation makes an in-flight frame/query straddle safe:
    // it can close normally, but its result cannot enter the new window.
    this.generation++;
    for (const pending of this.pending.splice(0)) this.gl.deleteQuery(pending.query);
    this.cpuByFrame.clear();
    this.gpuMs.length = 0;
    this.cpuMs.length = 0;
    this.rafMs.length = 0;
    this.pairedMs.length = 0;
    this.disjointCount = 0;
    // Reading clears the driver's disjoint epoch before the new measurement.
    if (this.ext) void this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
  }

  snapshot(): ProfilerSnapshot {
    this.pollGpuQueries();
    const gpu = distribution(this.gpuMs);
    const cpu = distribution(this.cpuMs);
    const raf = distribution(this.rafMs);
    const paired = distribution(this.pairedMs);
    return {
      gpuSupported: this.gpuSupported,
      gpuCounterBits: this.counterBits,
      gpuDisjointCount: this.disjointCount,
      gpuFrameMs: gpu,
      cpuFrameMs: cpu,
      rafIntervalMs: raf,
      budgetFrameMs: paired,
      budgetFrameMsMedian: paired.median,
      budgetFrameMsP95: paired.p95,
    };
  }

  dispose(): void {
    if (this.active) {
      // The engine only disposes between frames in normal use. If not, closing
      // the range is safer than leaking a query target.
      if (this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active.query);
      this.active = null;
    }
    for (const pending of this.pending.splice(0)) this.gl.deleteQuery(pending.query);
    this.cpuByFrame.clear();
  }

  private pollGpuQueries(): void {
    if (!this.ext) return;

    const disjoint = Boolean(this.gl.getParameter(this.ext.GPU_DISJOINT_EXT));
    if (disjoint) {
      this.disjointCount++;
      for (const pending of this.pending.splice(0)) this.gl.deleteQuery(pending.query);
      this.cpuByFrame.clear();
      this.gpuMs.length = 0;
      this.pairedMs.length = 0;
      return;
    }
    if (this.pending.length === 0) return;

    // Query completion is ordered. Stop at the first unavailable result rather
    // than walking the whole queue every frame.
    while (this.pending.length > 0) {
      const pending = this.pending[0];
      const available = Boolean(this.gl.getQueryParameter(
        pending.query,
        this.gl.QUERY_RESULT_AVAILABLE,
      ));
      if (!available) break;
      const elapsedNanoseconds = Number(this.gl.getQueryParameter(
        pending.query,
        this.gl.QUERY_RESULT,
      ));
      this.pending.shift();
      this.gl.deleteQuery(pending.query);
      const cpu = this.cpuByFrame.get(pending.frameId);
      this.cpuByFrame.delete(pending.frameId);
      if (
        pending.generation === this.generation
        && cpu?.generation === this.generation
        && Number.isFinite(elapsedNanoseconds)
        && elapsedNanoseconds > 0
      ) {
        const gpu = elapsedNanoseconds / 1_000_000;
        pushBounded(this.gpuMs, gpu);
        pushBounded(this.pairedMs, Math.max(gpu, cpu.value));
      }
    }
  }
}
