/**
 * The engine. Renderer, frame loop, system registry.
 *
 * Deliberately small. Everything that makes the game look or feel like anything
 * lives in a subsystem; this file only guarantees three things:
 *
 *  1. A correct HDR pipeline. Linear working space, physically-based lights,
 *     ACES filmic response. Getting this wrong makes every later texture and
 *     light decision a fight against the pipeline rather than with it, and is
 *     the single most common reason WebGL scenes read as "web" instead of
 *     "game".
 *  2. A fixed-step simulation decoupled from render rate, so movement,
 *     ballistics and AI behave identically at 30fps and 240fps.
 *  3. A deterministic frame order, so a subsystem never observes another
 *     subsystem half-updated.
 */

import * as THREE from 'three';
import type { EngineContext, InputState, QualityTier, System, UpdateContext } from './contracts.js';
import { EventBusImpl } from './bus.js';
import { FrameProfiler } from './profiler.js';

/** Simulation runs at this rate regardless of display refresh. */
const FIXED_STEP = 1 / 120;
/** Never simulate more than this in one frame; a stalled tab must not spiral. */
const MAX_FRAME = 0.25;

export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly bus = new EventBusImpl();
  readonly profiler: FrameProfiler;

  private systems: System[] = [];
  private byName = new Map<string, System>();
  private accumulator = 0;
  private last = 0;
  private frame = 0;
  private running = false;
  private rafId = 0;

  quality: QualityTier = 'ultra';
  input!: InputState;

  /** Set by the render subsystem when it takes over presentation. */
  present: ((u: UpdateContext) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // resolved in post (SMAA/TAA); MSAA does not
                                 // anti-alias specular or the HDR bloom source
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.profiler = new FrameProfiler(this.renderer);

    // ── Colour pipeline ──────────────────────────────────────────────────
    // Work in linear, present in sRGB, and map HDR through ACES. Without this
    // every bright surface clips to flat white and the image reads as "web
    // demo" no matter how good the materials are.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // ── Shadows ──────────────────────────────────────────────────────────
    // VSM trades a little bleed for soft, stable contact shadows. PCFSoft
    // shimmers badly under first-person motion, which reads as cheap.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = true;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    this.camera = new THREE.PerspectiveCamera(
      75,                                        // vertical FOV; weapons feel
                                                 // wrong below ~70 in FPS
      window.innerWidth / window.innerHeight,
      0.05,                                      // near: viewmodel must not clip
      2000,
    );
    this.camera.rotation.order = 'YXZ';          // yaw then pitch — the only
                                                 // order that never rolls the
                                                 // camera on look

    this.scene.matrixWorldAutoUpdate = true;

    window.addEventListener('resize', this.onResize, { passive: true });
    // iOS Safari rotates and shows/hides its URL bar without always firing a
    // timely `resize`; orientationchange + the VisualViewport's own resize cover
    // those, so the canvas keeps filling the screen through orientation flips.
    window.addEventListener('orientationchange', this.onDeferredResize, { passive: true });
    window.visualViewport?.addEventListener('resize', this.onResize, { passive: true });
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.bus.emit('engine:resize', { width: w, height: h });
  };

  // orientationchange can fire before the browser has settled the new
  // innerWidth/innerHeight, so read them on the next frame.
  private onDeferredResize = (): void => {
    requestAnimationFrame(this.onResize);
  };

  add(system: System): this {
    this.systems.push(system);
    this.byName.set(system.name, system);
    return this;
  }

  get<T extends System>(name: string): T | undefined {
    return this.byName.get(name) as T | undefined;
  }

  get context(): EngineContext {
    return {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      time: this.last,
      input: this.input,
      bus: this.bus,
      quality: this.quality,
      get: <T extends System>(n: string) => this.get<T>(n),
    };
  }

  async init(): Promise<void> {
    for (const s of this.systems) {
      await s.init?.(this.context);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now() / 1000;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now() / 1000;
    let dt = now - this.last;
    this.last = now;
    const frameToken = this.profiler.beginFrame(dt * 1000);
    if (dt > MAX_FRAME) dt = MAX_FRAME;   // a stalled tab must not fire a
                                          // thousand simulation steps at once

    const ctx = this.context;
    try {
      // ── Fixed-step simulation ──────────────────────────────────────────
      // Keep the whole frame inside the timing range and the finally block.
      // A fixed-step system can throw just as readily as a presentation
      // system; leaving TIME_ELAPSED active would poison every later frame.
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_STEP && steps < 8) {
        for (const s of this.systems) s.fixedUpdate?.(FIXED_STEP, ctx);
        this.accumulator -= FIXED_STEP;
        steps++;
      }

      // ── Presentation ───────────────────────────────────────────────────
      const u: UpdateContext = {
        dt,
        elapsed: now,
        frame: this.frame++,
        alpha: this.accumulator / FIXED_STEP, // interpolate fixed-step state
      };
      for (const s of this.systems) s.update?.(u, ctx);

      // GPU queries bracket only submitted render commands. Beginning the query
      // before simulation measures device idle time while JavaScript works.
      this.profiler.beginGpu();
      try {
        if (this.present) this.present(u);
        else this.renderer.render(this.scene, this.camera);
      } finally {
        this.profiler.endGpu();
      }
    } finally {
      // CPU covers simulation, presentation and command submission.
      this.profiler.endFrame(frameToken);
    }
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onDeferredResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    // Tear down dependants before providers (weapon/AI/player before level and
    // render). Forward disposal can restore a hook after its owner removed it.
    for (let i = this.systems.length - 1; i >= 0; i--) {
      this.systems[i].dispose?.();
    }
    this.bus.clear();
    this.profiler.dispose();
    this.renderer.dispose();
  }
}
