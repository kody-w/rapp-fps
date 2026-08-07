/**
 * The render pipeline. This is where "AAA" is won or lost.
 *
 * A ThreeJS scene with good models still reads as a web demo if the image
 * pipeline is wrong. The things that actually separate a shipped shooter's
 * frame from a WebGL demo, in rough order of how much they matter:
 *
 *  1. Anti-aliasing that survives motion. Jagged specular crawling on gun
 *     edges is the single loudest "this is a demo" signal.
 *  2. Ambient occlusion. Without contact darkening, everything looks like it
 *     is floating a millimetre above everything else.
 *  3. Bloom that only blooms genuinely bright things. HDR-thresholded, not a
 *     blur of the whole frame.
 *  4. Tone mapping and a colour grade. Untouched ACES output is flat; shipped
 *     games always push contrast and a slight cool/warm split.
 *  5. Lens behaviour — subtle chromatic aberration at the edges, vignette,
 *     and grain. Real cameras do this and the eye reads its absence as CG.
 *
 * Every one of these is cheap in isolation and transformative together.
 */

import * as THREE from 'three';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
  KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { EngineContext, System, UpdateContext } from '../core/contracts.js';

export class RenderSystem implements System {
  readonly name = 'render';

  private composer!: EffectComposer;
  private bloom!: BloomEffect;
  private ao!: N8AOPostPass;
  private ca!: ChromaticAberrationEffect;

  /** Recoil/impact shake, applied to the camera after all gameplay motion. */
  private shakeAmp = 0;
  private shakeFreq = 24;
  private shakeDecay = 0;
  private shakeT = 0;

  async init(ctx: EngineContext): Promise<void> {
    const { renderer, scene, camera } = ctx;

    this.composer = new EffectComposer(renderer, {
      // Half-float keeps the HDR range intact all the way to tone mapping, so
      // bloom thresholds mean something and bright surfaces roll off instead
      // of clipping to paper white.
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });

    this.composer.addPass(new RenderPass(scene, camera));

    // ── Ambient occlusion ────────────────────────────────────────────────
    // N8AO rather than the classic SSAO: it is temporally stable under
    // first-person motion, where the standard implementation swims visibly.
    this.ao = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
    this.ao.configuration.aoRadius = 1.4;
    this.ao.configuration.distanceFalloff = 0.8;
    this.ao.configuration.intensity = 3.0;
    this.ao.configuration.color = new THREE.Color(0, 0, 0);
    this.ao.configuration.halfRes = ctx.quality !== 'ultra';
    this.ao.setQualityMode(ctx.quality === 'ultra' ? 'High' : 'Medium');
    this.composer.addPass(this.ao);

    // ── Bloom ────────────────────────────────────────────────────────────
    // Thresholded well above mid-grey so only real emitters and blown
    // highlights bloom. A low threshold is what makes web scenes look hazy.
    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.3,
      intensity: 0.9,
      kernelSize: KernelSize.LARGE,
      mipmapBlur: true,
    });

    // ── Lens ─────────────────────────────────────────────────────────────
    // Values deliberately near the threshold of perception. Anything you can
    // consciously see here is too much and reads as a filter.
    this.ca = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0006, 0.0006),
      radialModulation: true,
      modulationOffset: 0.4,
    });

    const vignette = new VignetteEffect({
      offset: 0.28,
      darkness: 0.55,
    });

    const grain = new NoiseEffect({
      blendFunction: BlendFunction.OVERLAY,
      premultiply: true,
    });
    grain.blendMode.opacity.value = 0.055;

    const tone = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,   // AgX holds saturation in highlights far
                                   // better than ACES; muzzle flashes stay
                                   // orange instead of going white
      resolution: 256,
      whitePoint: 8.0,
      middleGrey: 0.42,
    });

    const smaa = new SMAAEffect({ preset: SMAAPreset.ULTRA });

    this.composer.addPass(new EffectPass(camera, this.bloom, this.ca, vignette, grain, tone));
    this.composer.addPass(new EffectPass(camera, smaa));

    ctx.bus.on('engine:resize', (p: unknown) => {
      const { width, height } = p as { width: number; height: number };
      this.composer.setSize(width, height);
      this.ao.setSize(width, height);
    });

    ctx.bus.on('camera:shake', (p: unknown) => {
      const s = p as { amplitude?: number; duration?: number; frequency?: number };
      // Take the strongest request rather than summing: two simultaneous
      // shakes should not double the amplitude into nausea.
      this.shakeAmp = Math.max(this.shakeAmp, s.amplitude ?? 0.02);
      this.shakeDecay = 1 / Math.max(0.05, s.duration ?? 0.25);
      this.shakeFreq = s.frequency ?? 24;
      this.shakeT = 0;
    });
  }

  update(u: UpdateContext, ctx: EngineContext): void {
    if (this.shakeAmp > 0.0001) {
      this.shakeT += u.dt;
      const a = this.shakeAmp;
      // Two incommensurate frequencies so the motion never reads as a loop.
      ctx.camera.rotation.z += Math.sin(this.shakeT * this.shakeFreq) * a * 0.6;
      ctx.camera.rotation.x += Math.sin(this.shakeT * this.shakeFreq * 1.7) * a;
      ctx.camera.rotation.y += Math.cos(this.shakeT * this.shakeFreq * 1.3) * a * 0.8;
      this.shakeAmp = Math.max(0, this.shakeAmp - this.shakeDecay * u.dt * this.shakeAmp * 4);
    }
  }

  /** Called by the engine instead of a bare renderer.render. */
  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
