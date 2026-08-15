/**
 * Procedural PBR materials for the arena. Every texel comes out of a canvas and
 * a little value noise — there is no image asset, no downloaded HDRI, no third
 * party texture. That is a licence decision, not a technicality: everything here
 * is generated from code and is therefore CC0 / original. The metals and
 * concrete are `MeshStandardMaterial`s so they are lit by the render pipeline's
 * procedural-sky IBL, which is what makes them read as surfaces that are
 * somewhere rather than coloured plastic.
 *
 * The container material is vertex-coloured: one merged draw call carries the
 * whole weathered-container palette (see geometry.ts / arena.ts tints).
 */

import * as THREE from 'three';
import type { MaterialKey } from './arena.js';

export interface ArenaMaterials {
  readonly byKey: Record<MaterialKey, THREE.Material>;
  readonly textures: THREE.Texture[];
  readonly materials: THREE.Material[];
  readonly textureMemoryBytes: number;
  dispose(): void;
}

// ── Deterministic noise (no runtime randomness that could desync captures) ──

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x ^ seed, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const tx = x / cell - gx;
  const ty = y / cell - gy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const top = THREE.MathUtils.lerp(hash(gx, gy, seed), hash(gx + 1, gy, seed), sx);
  const bottom = THREE.MathUtils.lerp(hash(gx, gy + 1, seed), hash(gx + 1, gy + 1, seed), sx);
  return THREE.MathUtils.lerp(top, bottom, sy);
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let v = state;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated { texture: THREE.CanvasTexture; bytes: number }

function makeTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
  color: boolean,
): Generated {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas unavailable for procedural arena textures');
  draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, bytes: Math.ceil(size * size * 4 * (4 / 3)) };
}

// ── Texture painters ────────────────────────────────────────────────────────

const concreteAlbedo = (): Generated => makeTexture(512, (ctx, s) => {
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const grain = hash(x, y, 91) * 16 - 8;
      const aggregate = valueNoise(x, y, 21, 433) * 14 - 7;
      const broad = (valueNoise(x, y, 96, 901) * 2 - 1) * 9;
      const v = grain + aggregate + broad;
      img.data[i] = 138 + v;
      img.data[i + 1] = 143 + v;
      img.data[i + 2] = 147 + v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const rnd = seeded(0xc0ffee);
  ctx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(28, 33, 38, ${0.03 + rnd() * 0.05})`;
    ctx.beginPath();
    ctx.ellipse(rnd() * s, rnd() * s, 10 + rnd() * 50, 4 + rnd() * 18, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(40, 44, 48, 0.5)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    let x = rnd() * s;
    let y = rnd() * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let j = 0; j < 6; j++) {
      x += rnd() * 40 - 20;
      y += 10 + rnd() * 34;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}, true);

const roughFromNoise = (seed: number, base: number, range: number): Generated => makeTexture(512, (ctx, s) => {
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = valueNoise(x, y, 18, seed) * 0.6 + hash(x, y, seed + 7) * 0.4;
      const v = Math.max(0, Math.min(255, base + (n * 2 - 1) * range));
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}, false);

// ── Container corrugation profile ───────────────────────────────────────────
// The single source of truth for the container rib. Both the albedo brightness
// stripes AND the tangent-space normal map below are generated from THIS
// function, so a rib's bright edge and its geometric slope coincide — the fix
// for #67, where corrugation was albedo-only and the bump map was unrelated
// generic metal noise, so ribs never self-shaded with light direction.
export const CONTAINER_RIB_FREQUENCY = 0.20;

/** Corrugation height in 0..1 at texel column `x`. Shared by albedo + normal. */
export function containerRibHeight(x: number): number {
  return Math.sin(x * CONTAINER_RIB_FREQUENCY) * 0.5 + 0.5;
}

// Painted-metal panel: light base so a vertex-colour tint reads through, with
// corrugation rib shadows and vertical weathering streaks.
const panelAlbedo = (): Generated => makeTexture(256, (ctx, s) => {
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const rib = containerRibHeight(x) * 34; // corrugation (shared profile)
      const grain = hash(x, y, 5501) * 10 - 5;
      const v = 196 + rib + grain;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const rnd = seeded(0x51a7);
  ctx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 22; i++) {
    const x = rnd() * s;
    const w = 1 + rnd() * 5;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(80, 44, 24, 0)');
    g.addColorStop(0.5, `rgba(80, 44, 24, ${0.1 + rnd() * 0.18})`);
    g.addColorStop(1, 'rgba(80, 44, 24, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, rnd() * s * 0.5, w, s * 0.4 + rnd() * s * 0.6);
  }
}, true);

// Container corrugation NORMAL map (#67). A tangent-space normal derived from a
// height field = the shared rib profile + deterministic weathering dents, so the
// ribs actually catch and shed light as the sun direction changes rather than
// being flat brightness stripes. Central differences on a wrapped height field
// keep it seamless under RepeatWrapping; NoColorSpace (linear) because it is a
// normal, not colour.
const containerNormal = (): Generated => makeTexture(256, (ctx, s) => {
  const img = ctx.createImageData(s, s);
  const RIB_AMP = 30; //     rib height weight (drives the dominant X slope)
  const WEATHER_AMP = 7; //  subtle dents/oil-canning so panels are not glassy
  const STRENGTH = 0.06; //  height→slope gain, tuned with material.normalScale
  const height = (x: number, y: number): number =>
    containerRibHeight(((x % s) + s) % s) * RIB_AMP
    + valueNoise(((x % s) + s) % s, ((y % s) + s) % s, 22, 6203) * WEATHER_AMP;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const dhx = (height(x + 1, y) - height(x - 1, y)) * 0.5 * STRENGTH;
      const dhy = (height(x, y + 1) - height(x, y - 1)) * 0.5 * STRENGTH;
      let nx = -dhx;
      let ny = -dhy;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}, false);

const galvAlbedo = (): Generated => makeTexture(256, (ctx, s) => {
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      // Spangled galvanised look: blocky cells of slightly varied brightness.
      const spangle = valueNoise(x, y, 9, 8123) * 40 - 20;
      const grain = hash(x, y, 313) * 14 - 7;
      const v = 190 + spangle + grain;
      img.data[i] = v - 4;
      img.data[i + 1] = v;
      img.data[i + 2] = v + 6;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}, true);

const rustAlbedo = (): Generated => makeTexture(256, (ctx, s) => {
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const mottle = valueNoise(x, y, 12, 4242);
      const fine = hash(x, y, 99) * 0.3;
      const t = Math.min(1, mottle * 0.8 + fine);
      img.data[i] = 96 + t * 92;
      img.data[i + 1] = 52 + t * 52;
      img.data[i + 2] = 34 + t * 26;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}, true);

const woodAlbedo = (): Generated => makeTexture(256, (ctx, s) => {
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      // Gentle lengthwise warp, then tight high-frequency grain so planks read
      // as timber rather than a cartoon swirl. Amplitudes kept low and muted.
      const warp = (valueNoise(x, y, 64, 808) * 2 - 1) * 5;
      const fibre = Math.sin((y + warp) * 0.55) * 4 + Math.sin((y + warp) * 1.7) * 2.4;
      const pores = (hash(x, y, 1945) - 0.5) * 6;
      const ring = (valueNoise(x, y, 30, 233) - 0.5) * 5;
      img.data[i] = 150 + fibre + pores + ring;
      img.data[i + 1] = 120 + fibre * 0.7 + pores + ring * 0.7;
      img.data[i + 2] = 86 + fibre * 0.45 + pores + ring * 0.4;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Plank seams — thin, dark, softly varied.
  const rnd = seeded(0x71be);
  ctx.strokeStyle = 'rgba(46, 30, 17, 0.5)';
  ctx.lineWidth = 1.4;
  for (let py = 30; py < s; py += 40 + Math.floor(rnd() * 8)) {
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(s, py + rnd() * 3 - 1.5);
    ctx.stroke();
  }
}, true);

export interface ArenaMaterialsOptions {
  /**
   * Attach the rib-derived container normal map (#67) so corrugation responds to
   * light direction. Default true (production). Set false to reproduce the exact
   * pre-#67 container material (albedo-only rib + generic metal bump) for a
   * matched "before" evidence frame — this generates one fewer texture.
   */
  readonly containerRibNormal?: boolean;
}

export function createArenaMaterials(
  renderer: THREE.WebGLRenderer,
  options: ArenaMaterialsOptions = {},
): ArenaMaterials {
  const ribNormalOn = options.containerRibNormal ?? true;
  const gen: Generated[] = [
    concreteAlbedo(),      // 0
    roughFromNoise(1207, 172, 46), // 1 concrete rough/bump
    panelAlbedo(),         // 2
    roughFromNoise(88, 120, 40),   // 3 metal rough/bump
    galvAlbedo(),          // 4
    rustAlbedo(),          // 5
    woodAlbedo(),          // 6
  ];
  const [concreteMap, concreteRough, panelMap, metalRough, galvMap, rustMap, woodMap] =
    gen.map((g) => g.texture);
  // One additional generated texture, and only when the rib response is on.
  const containerNormalGen = ribNormalOn ? containerNormal() : undefined;
  if (containerNormalGen) gen.push(containerNormalGen);

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const g of gen) g.texture.anisotropy = aniso;

  const concrete = new THREE.MeshStandardMaterial({
    color: 0x9aa0a3,
    map: concreteMap,
    roughnessMap: concreteRough,
    bumpMap: concreteRough,
    bumpScale: 0.05,
    roughness: 0.9,
    metalness: 0.0,
  });
  const concreteDark = concrete.clone();
  concreteDark.color.setHex(0x4c565b);
  concreteDark.roughness = 0.96;
  concreteDark.bumpScale = 0.03;

  const galvanized = new THREE.MeshStandardMaterial({
    color: 0xc6cfd2,
    map: galvMap,
    roughnessMap: metalRough,
    bumpMap: metalRough,
    bumpScale: 0.02,
    roughness: 0.44,
    metalness: 0.78,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x4a565d,
    map: galvMap,
    roughnessMap: metalRough,
    bumpMap: metalRough,
    bumpScale: 0.02,
    roughness: 0.6,
    metalness: 0.5,
  });
  const rust = new THREE.MeshStandardMaterial({
    color: 0x9a6446,
    map: rustMap,
    roughnessMap: metalRough,
    bumpMap: metalRough,
    bumpScale: 0.04,
    roughness: 0.86,
    metalness: 0.24,
  });
  const wood = new THREE.MeshStandardMaterial({
    color: 0xa8906c,
    map: woodMap,
    roughness: 0.86,
    metalness: 0.0,
  });
  const container = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: panelMap,
    roughnessMap: metalRough, // deterministic weathering (kept, per #67)
    roughness: 0.52,
    metalness: 0.34,
    vertexColors: true,
  });
  if (containerNormalGen) {
    // #67 fix: ribs are now a real normal profile from the same corrugation
    // function as the albedo, so they self-shade with the sun direction.
    container.normalMap = containerNormalGen.texture;
    container.normalScale = new THREE.Vector2(0.9, 0.9);
  } else {
    // Pre-#67 baseline: generic metal-noise bump, unrelated to the rib.
    container.bumpMap = metalRough;
    container.bumpScale = 0.03;
  }
  const safety = new THREE.MeshStandardMaterial({
    color: 0xe4a52c,
    roughness: 0.6,
    metalness: 0.08,
  });
  const lampWarm = new THREE.MeshStandardMaterial({
    color: 0xffb066,
    emissive: 0xff7a24,
    emissiveIntensity: 9,
    roughness: 0.3,
    metalness: 0.05,
  });
  const beacon = new THREE.MeshStandardMaterial({
    color: 0x9af0ff,
    emissive: 0x40cfe6,
    emissiveIntensity: 6,
    roughness: 0.24,
    metalness: 0.05,
  });

  const byKey: Record<MaterialKey, THREE.Material> = {
    concrete, concreteDark, galvanized, darkMetal, rust, wood, container, safety, lampWarm, beacon,
  };
  const materials = Object.values(byKey);
  const textures = gen.map((g) => g.texture);

  return {
    byKey,
    textures,
    materials,
    textureMemoryBytes: gen.reduce((t, g) => t + g.bytes, 0),
    dispose(): void {
      for (const m of materials) m.dispose();
      for (const t of textures) {
        const src = t.source?.data as HTMLCanvasElement | undefined;
        t.dispose();
        if (src instanceof HTMLCanvasElement) {
          src.width = 0;
          src.height = 0;
        }
      }
    },
  };
}
