/**
 * A procedurally generated environment. No image asset, no downloaded HDRI —
 * every value here comes out of a shader, which is the whole point: metals with
 * nothing to reflect read as plastic, and the fix a critic actually sees is an
 * environment the surfaces are standing *in*.
 *
 * What this produces, once, at boot:
 *
 *  - a crisp cubemap of a graded dusk sky with a single warm sun, used as the
 *    scene background so the frame is a place rather than a black void; and
 *  - a PMREM prefilter of that same cubemap, used as `scene.environment` so
 *    every MeshStandardMaterial gets image-based lighting — real specular
 *    reflections on the metals, real ambient on everything else.
 *
 * Both come from ONE render of the sky, so the reflection in a chrome sphere and
 * the sky behind it are the same sky. The sun direction is handed in so it can
 * be aligned with the scene key light: the highlight a viewer sees on the metal
 * then agrees with the shadow the key light casts, which is the kind of quiet
 * coherence whose absence reads as "CG" without anyone being able to say why.
 *
 * The bake is one-time. At runtime this adds zero fullscreen passes, but the
 * materials do sample the environment texture. Three current trials measured
 * 6.5ms default versus 6.3ms with IBL disabled while holding the sky constant,
 * inside the harness's ~0.9ms run-to-run range. The cost is below the current
 * instrument's resolution, not proven zero.
 */

import * as THREE from 'three';

export interface SkyParams {
  /** World-space direction the sun sits in. Aligned to the scene key light. */
  sunDirection: THREE.Vector3;
  /** Linear-radiance sun tint. Warm, to match a warm key. */
  sunColor?: THREE.Color;
  /** Deep-sky colour overhead (linear). */
  zenith?: THREE.Color;
  /** Hazier colour at the horizon (linear). */
  horizon?: THREE.Color;
  /** Colour below the horizon line (linear). */
  ground?: THREE.Color;
  /** Peak radiance of the sun disc. HDR, so it blooms and drives IBL. */
  sunIntensity?: number;
  /** Cube face resolution for the baked background. */
  resolution?: number;
}

export interface SkyResult {
  /** PMREM-prefiltered environment for `scene.environment` (IBL). */
  environment: THREE.Texture;
  /** Crisp cubemap for `scene.background`. */
  background: THREE.CubeTexture;
  /** Releases both render targets. */
  dispose(): void;
}

const VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // The dome is centred on the cube camera, so a vertex position IS the view
    // direction for that texel. Normalising in the fragment keeps it exact.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  varying vec3 vDir;

  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform float uSunIntensity;

  void main() {
    vec3 d = normalize(vDir);
    vec3 s = normalize(uSunDir);
    float y = d.y;
    float up = clamp(y, 0.0, 1.0);

    // Vertical gradient.
    vec3 sky = mix(uHorizon, uZenith, pow(up, 0.42));

    // Below the horizon fades to a dark ground softly to remove abrupt seam
    float below = clamp(-y * 4.0, 0.0, 1.0);
    vec3 col = mix(sky, uGround, below);

    float mu = dot(d, s);
    
    // Smoothly fade out sun and haze at the very horizon to perfectly match the ground fog
    float horizonBlend = smoothstep(0.0, 0.1, up);

    // Two-lobe sun glow: a wide soft halo plus a tighter core.
    float glow = pow(max(mu, 0.0), 5.0) * 0.16
               + pow(max(mu, 0.0), 90.0) * 0.5;
    col += uSunColor * glow * horizonBlend;

    // Sun angular core with gradual roll-off, no flat clipped disk
    float core = pow(max(mu, 0.0), 400.0) * (uSunIntensity * 0.3);
    float center = pow(max(mu, 0.0), 3000.0) * (uSunIntensity * 0.7);
    col += (uSunColor * core + uSunColor * center) * horizonBlend;

    // Warm haze piled up along the horizon toward the sun's azimuth.
    float haze = pow(1.0 - up, 6.0) * smoothstep(-0.35, 1.0, mu);
    col += uSunColor * haze * 0.22 * horizonBlend;

    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  }
`;

/**
 * Bakes the sky once and returns the two textures. `renderer` state (render
 * target, tone mapping) is saved and restored, so calling this mid-setup does
 * not disturb the caller.
 */
export function generateSky(renderer: THREE.WebGLRenderer, params: SkyParams): SkyResult {
  const resolution = params.resolution ?? 512;

  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uSunDir: { value: params.sunDirection.clone().normalize() },
      uSunColor: { value: params.sunColor ?? new THREE.Color(1.0, 0.74, 0.5) },
      uZenith: { value: params.zenith ?? new THREE.Color(0.01, 0.02, 0.05) },
      uHorizon: { value: params.horizon ?? new THREE.Color(0x0b0e13).convertSRGBToLinear() },
      uGround: { value: params.ground ?? new THREE.Color(0x0b0e13).convertSRGBToLinear() },
      uSunIntensity: { value: params.sunIntensity ?? 26.0 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });

  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const dome = new THREE.Mesh(geometry, material);
  const skyScene = new THREE.Scene();
  skyScene.add(dome);

  // The baked cube must hold linear HDR radiance: the composer tone-maps once,
  // at the end, in AgX. Baking through the renderer's tone mapping here would
  // map twice. Half-float keeps the sun's HDR range for both bloom and IBL.
  const cubeTarget = new THREE.WebGLCubeRenderTarget(resolution, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

  const prevTarget = renderer.getRenderTarget();
  const prevCubeFace = renderer.getActiveCubeFace();
  const prevMipmapLevel = renderer.getActiveMipmapLevel();
  const prevToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;

  const cubeCamera = new THREE.CubeCamera(0.1, 10, cubeTarget);
  cubeCamera.update(renderer, skyScene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromCubemap(cubeTarget.texture);

  renderer.toneMapping = prevToneMapping;
  // Preserve the complete target state. Omitting face/mip silently resets an
  // active cube face, array layer or mip level to zero.
  renderer.setRenderTarget(prevTarget, prevCubeFace, prevMipmapLevel);

  // The scratch geometry, material and PMREM helper are done. The two render
  // targets stay alive because their textures are now in use by the scene.
  geometry.dispose();
  material.dispose();
  pmrem.dispose();

  return {
    environment: envTarget.texture,
    background: cubeTarget.texture,
    dispose() {
      cubeTarget.dispose();
      envTarget.dispose();
    },
  };
}
