/**
 * The render pipeline. This is where "AAA" is won or lost.
 *
 * A ThreeJS scene with good models still reads as a web demo if the image
 * pipeline is wrong. The things that actually separate a shipped shooter's
 * frame from a WebGL demo, in rough order of how much they matter:
 *
 *  0. An environment to be lit BY. Physically-based metals with nothing to
 *     reflect read as coloured plastic; a floor under a black void reads as
 *     paper on a desk. Image-based lighting from a real (here: procedurally
 *     generated) environment is the difference between "PBR materials" and
 *     "materials that are somewhere". It adds no fullscreen pass and measured
 *     ~0.1ms on the M4 (6.2ms default versus 6.1ms with `?env=0`), which is why
 *     it leads this list ahead of effects that cost whole milliseconds.
 *  1. Anti-aliasing that survives motion. Jagged specular crawling on gun
 *     edges is the single loudest "this is a demo" signal.
 *  2. Ambient occlusion. Without contact darkening, everything looks like it
 *     is floating a millimetre above everything else.
 *  3. Bloom that only blooms genuinely bright things. HDR-thresholded, not a
 *     blur of the whole frame.
 *  4. Tone mapping and a colour grade. Untouched output is flat; shipped games
 *     always push contrast and a slight cool/warm split.
 *  5. Lens behaviour — subtle chromatic aberration at the edges, vignette,
 *     and grain. Real cameras do this and the eye reads its absence as CG.
 *
 * The exact tier of each effect is not a matter of taste here — it is measured.
 * Every knob below is reachable from the URL so `tools/shoot.mjs` can price each
 * effect against the 16.7ms budget in isolation, and the defaults are whatever
 * that measurement chose. See the commit that set them for the numbers.
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
  type Effect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { EngineContext, System, UpdateContext } from '../core/contracts.js';
import { generateSky, type SkyResult } from './ProceduralSky.js';

type AoMode = 'full' | 'half' | 'off';
type AaMode = 'ultra' | 'high' | 'medium' | 'low' | 'off';
type BloomMode = 'large' | 'medium' | 'small' | 'off';

interface RenderConfig {
  /** Image-based lighting from the procedural sky. */
  env: boolean;
  /** Whether the sky is also drawn as the background, or the level's void kept. */
  bg: 'sky' | 'dark';
  ao: AoMode;
  aoQuality: 'High' | 'Medium' | 'Low';
  aa: AaMode;
  bloom: BloomMode;
  /** Chromatic aberration + vignette + grain, together — the lens character. */
  lens: boolean;
}

/**
 * How hard the procedural sky lights the scene. The level already carries a
 * hemisphere fill; at 1.0 the two stack into a flat over-lit read, so the IBL is
 * pulled back to sit under the directional key rather than compete with it.
 */
const ENV_INTENSITY = 0.55;

/** The key light's world direction, so the sun the metals reflect agrees with the shadow the key casts. */
const SUN_DIRECTION = new THREE.Vector3(-8, 14, 6);

function readConfig(): RenderConfig {
  const q = typeof location !== 'undefined'
    ? new URLSearchParams(location.search)
    : new URLSearchParams();

  const pick = <T extends string>(key: string, fallback: T, allowed: readonly T[]): T => {
    const v = q.get(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = q.get(key);
    if (v === null) return fallback;
    return v !== '0' && v !== 'off' && v !== 'false';
  };

  return {
    env: bool('env', true),
    bg: pick('bg', 'sky', ['sky', 'dark'] as const),
    ao: pick('ao', 'half', ['full', 'half', 'off'] as const),
    aoQuality: pick('aoq', 'High', ['High', 'Medium', 'Low'] as const),
    aa: pick('aa', 'ultra', ['ultra', 'high', 'medium', 'low', 'off'] as const),
    bloom: pick('bloom', 'medium', ['large', 'medium', 'small', 'off'] as const),
    lens: bool('lens', true),
  };
}

function kernelFor(mode: Exclude<BloomMode, 'off'>): KernelSize {
  switch (mode) {
    case 'large': return KernelSize.LARGE;
    case 'medium': return KernelSize.MEDIUM;
    case 'small': return KernelSize.SMALL;
  }
}

function presetFor(mode: Exclude<AaMode, 'off'>): SMAAPreset {
  switch (mode) {
    case 'ultra': return SMAAPreset.ULTRA;
    case 'high': return SMAAPreset.HIGH;
    case 'medium': return SMAAPreset.MEDIUM;
    case 'low': return SMAAPreset.LOW;
  }
}

export class RenderSystem implements System {
  readonly name = 'render';

  private composer!: EffectComposer;
  private bloom?: BloomEffect;
  private ao?: N8AOPostPass;
  private ca?: ChromaticAberrationEffect;
  private sky?: SkyResult;

  /** Background set here, applied on the first frame — the level's init runs after ours. */
  private pendingBackground: THREE.CubeTexture | null = null;
  private appliedBackground = false;

  /** Recoil/impact shake, applied to the camera after all gameplay motion. */
  private shakeAmp = 0;
  private shakeFreq = 24;
  private shakeDecay = 0;
  private shakeT = 0;

  async init(ctx: EngineContext): Promise<void> {
    const { renderer, scene, camera } = ctx;
    const cfg = readConfig();

    this.composer = new EffectComposer(renderer, {
      // Half-float keeps the HDR range intact all the way to tone mapping, so
      // bloom thresholds mean something and bright surfaces roll off instead
      // of clipping to paper white.
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });

    this.composer.addPass(new RenderPass(scene, camera));

    // ── Image-based lighting ─────────────────────────────────────────────
    // The single largest visual change per millisecond spent: a procedurally
    // baked sky gives the metals something real to reflect and the floor a sky
    // to catch at grazing angles. It adds no fullscreen pass and measured
    // ~0.1ms rather than the zero originally claimed. Built before the passes
    // so material sampling is live from frame one.
    if (cfg.env) {
      this.sky = generateSky(renderer, {
        sunDirection: SUN_DIRECTION,
        sunColor: new THREE.Color(1.0, 0.74, 0.5),
        zenith: new THREE.Color(0.035, 0.075, 0.17),
        horizon: new THREE.Color(0.16, 0.2, 0.27),
        ground: new THREE.Color(0.02, 0.018, 0.016),
        sunIntensity: 26.0,
        resolution: 512,
      });
      scene.environment = this.sky.environment;
      scene.environmentIntensity = ENV_INTENSITY;
      if (cfg.bg === 'sky') this.pendingBackground = this.sky.background;
    }

    // ── Ambient occlusion ────────────────────────────────────────────────
    // N8AO rather than the classic SSAO: it is temporally stable under
    // first-person motion, where the standard implementation swims visibly.
    // Half-resolution by default — see the budget commit; at 1080p the full-res
    // pass is the single most expensive thing in the frame and the half-res
    // result is indistinguishable once the denoise runs.
    if (cfg.ao !== 'off') {
      this.ao = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
      this.ao.configuration.aoRadius = 1.4;
      this.ao.configuration.distanceFalloff = 0.8;
      this.ao.configuration.intensity = 3.0;
      this.ao.configuration.color = new THREE.Color(0, 0, 0);
      this.ao.configuration.halfRes = cfg.ao === 'half';
      this.ao.setQualityMode(cfg.aoQuality);
      this.composer.addPass(this.ao);
    }

    // ── Effect chain ─────────────────────────────────────────────────────
    const effects: Effect[] = [];

    if (cfg.bloom !== 'off') {
      // Thresholded well above mid-grey so only real emitters and blown
      // highlights bloom. A low threshold is what makes web scenes look hazy.
      this.bloom = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        luminanceThreshold: 0.85,
        luminanceSmoothing: 0.3,
        intensity: 0.9,
        kernelSize: kernelFor(cfg.bloom),
        mipmapBlur: true,
      });
      effects.push(this.bloom);
    }

    if (cfg.lens) {
      // Values deliberately near the threshold of perception. Anything you can
      // consciously see here is too much and reads as a filter.
      this.ca = new ChromaticAberrationEffect({
        offset: new THREE.Vector2(0.0006, 0.0006),
        radialModulation: true,
        modulationOffset: 0.4,
      });
      const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.55 });
      const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
      grain.blendMode.opacity.value = 0.055;
      effects.push(this.ca, vignette, grain);
    }

    // Tone mapping is not optional: it is what turns the linear HDR buffer into
    // a displayable image. AgX holds saturation in highlights far better than
    // ACES; muzzle flashes stay orange instead of going white.
    const tone = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,
      resolution: 256,
      whitePoint: 8.0,
      middleGrey: 0.42,
    });
    effects.push(tone);

    const smaa = cfg.aa !== 'off' ? new SMAAEffect({ preset: presetFor(cfg.aa) }) : null;

    // SMAA is a convolution effect and must stay in its own pass. An earlier
    // debug knob exposed `?merge=1` and claimed the composer could reorder it;
    // the actual runtime correctly refused with:
    //
    //   Error: Convolution effects cannot be merged (ChromaticAberrationEffect)
    //
    // A knob that only crashes is not instrumentation. Keep the valid ordering
    // explicit instead of presenting an unsupported experiment as a feature.
    this.composer.addPass(new EffectPass(camera, ...effects));
    if (smaa) this.composer.addPass(new EffectPass(camera, smaa));

    ctx.bus.on('engine:resize', (p: unknown) => {
      const { width, height } = p as { width: number; height: number };
      this.composer.setSize(width, height);
      this.ao?.setSize(width, height);
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
    // The level sets its own background in its init, which runs after ours, so
    // the sky background has to be applied once here after everyone is set up.
    if (!this.appliedBackground) {
      this.appliedBackground = true;
      if (this.pendingBackground) ctx.scene.background = this.pendingBackground;
    }

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
    this.sky?.dispose();
  }
}
