import * as THREE from 'three';

export interface PortMaterials {
  ground: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  concreteDark: THREE.MeshStandardMaterial;
  paintedMetal: THREE.MeshStandardMaterial;
  darkMetal: THREE.MeshStandardMaterial;
  rustedMetal: THREE.MeshStandardMaterial;
  safetyYellow: THREE.MeshStandardMaterial;
  safetyWhite: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  water: THREE.MeshPhysicalMaterial;
  puddle: THREE.MeshPhysicalMaterial;
  emissiveOrange: THREE.MeshStandardMaterial;
  emissiveCyan: THREE.MeshStandardMaterial;
  emissiveRed: THREE.MeshStandardMaterial;
  sign: THREE.MeshStandardMaterial;
  steam: THREE.PointsMaterial;
  textures: THREE.Texture[];
  materials: THREE.Material[];
  textureMemoryBytes: number;
}

interface GeneratedTexture {
  texture: THREE.CanvasTexture;
  bytes: number;
}

const hash = (x: number, y: number, seed: number): number => {
  let h = Math.imul(x ^ seed, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const valueNoise = (x: number, y: number, cell: number, seed: number): number => {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const tx = (x / cell) - gx;
  const ty = (y / cell) - gy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const top = THREE.MathUtils.lerp(hash(gx, gy, seed), hash(gx + 1, gy, seed), sx);
  const bottom = THREE.MathUtils.lerp(
    hash(gx, gy + 1, seed),
    hash(gx + 1, gy + 1, seed),
    sx,
  );
  return THREE.MathUtils.lerp(top, bottom, sy);
};

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const makeCanvasTexture = (
  width: number,
  height: number,
  draw: (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => void,
  colorTexture: boolean,
): GeneratedTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('2D canvas unavailable for procedural level textures');
  draw(canvas, context);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = colorTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;

  return {
    texture,
    bytes: Math.ceil(width * height * 4 * (4 / 3)),
  };
};

const concreteColor = (): GeneratedTexture => makeCanvasTexture(512, 512, (canvas, context) => {
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const grain = hash(x, y, 91) * 18 - 9;
      const aggregate = valueNoise(x, y, 23, 433) * 14 - 7;
      const broad = (valueNoise(x, y, 91, 901) * 2 - 1) * 8;
      image.data[i] = 148 + grain + aggregate + broad;
      image.data[i + 1] = 156 + grain + aggregate + broad;
      image.data[i + 2] = 160 + grain + aggregate + broad;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  const random = seeded(0xc0ffee);
  context.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 32; i++) {
    context.fillStyle = `rgba(24, 31, 34, ${0.025 + random() * 0.055})`;
    context.beginPath();
    context.ellipse(
      random() * canvas.width,
      random() * canvas.height,
      12 + random() * 54,
      4 + random() * 20,
      random() * Math.PI,
      0,
      Math.PI * 2,
    );
    context.fill();
  }

  context.globalCompositeOperation = 'screen';
  context.strokeStyle = 'rgba(130, 139, 142, 0.20)';
  context.lineWidth = 1;
  for (let i = 0; i < 10; i++) {
    let x = random() * canvas.width;
    let y = random() * canvas.height;
    context.beginPath();
    context.moveTo(x, y);
    for (let j = 0; j < 6; j++) {
      x += random() * 34 - 17;
      y += 12 + random() * 32;
      context.lineTo(x, y);
    }
    context.stroke();
  }
}, true);

const concreteDetail = (): GeneratedTexture => makeCanvasTexture(512, 512, (canvas, context) => {
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const pin = hash(x, y, 719) * 42;
      const broad = valueNoise(x, y, 19, 1201) * 22;
      const value = 187 + pin + broad;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}, false);

const metalColor = (): GeneratedTexture => makeCanvasTexture(256, 256, (canvas, context) => {
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const corrugation = Math.sin(x * 0.34) * 13;
      const grain = hash(x, y, 31337) * 16 - 8;
      const streak = hash(Math.floor(x / 19), Math.floor(y / 47), 991) * 10;
      image.data[i] = 184 + corrugation + grain + streak;
      image.data[i + 1] = 192 + corrugation + grain + streak;
      image.data[i + 2] = 195 + corrugation + grain + streak;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  const random = seeded(0x51a7);
  context.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 26; i++) {
    const x = random() * canvas.width;
    const width = 2 + random() * 13;
    const gradient = context.createLinearGradient(x, 0, x + width, 0);
    gradient.addColorStop(0, 'rgba(111, 47, 19, 0)');
    gradient.addColorStop(0.5, `rgba(111, 47, 19, ${0.08 + random() * 0.16})`);
    gradient.addColorStop(1, 'rgba(111, 47, 19, 0)');
    context.fillStyle = gradient;
    context.fillRect(x, random() * 110, width, 80 + random() * 176);
  }
}, true);

const metalDetail = (): GeneratedTexture => makeCanvasTexture(256, 256, (canvas, context) => {
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const grooves = (Math.sin(x * 0.34) * 0.5 + 0.5) * 42;
      const pitting = hash(x, y, 1776) * 38;
      const value = 154 + grooves + pitting;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}, false);

const maintenanceSign = (): GeneratedTexture => makeCanvasTexture(512, 128, (canvas, context) => {
  context.fillStyle = '#e5ad2f';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#131a1f';
  for (let x = -40; x < canvas.width + 40; x += 54) {
    context.save();
    context.translate(x, 0);
    context.rotate(-0.42);
    context.fillRect(0, -80, 22, 300);
    context.restore();
  }
  context.fillStyle = 'rgba(8, 14, 18, 0.92)';
  context.fillRect(18, 17, 476, 94);
  context.fillStyle = '#dce9e9';
  context.font = '700 50px system-ui, sans-serif';
  context.textBaseline = 'middle';
  context.fillText('MAINT 04', 38, 64);
  context.fillStyle = '#65d8e4';
  context.beginPath();
  context.moveTo(445, 40);
  context.lineTo(482, 64);
  context.lineTo(445, 88);
  context.closePath();
  context.fill();
}, true);

const steamSprite = (): GeneratedTexture => makeCanvasTexture(128, 128, (canvas, context) => {
  const gradient = context.createRadialGradient(64, 64, 2, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.28, 'rgba(234,247,250,0.42)');
  gradient.addColorStop(0.68, 'rgba(212,231,235,0.12)');
  gradient.addColorStop(1, 'rgba(190,218,224,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
}, false);

export const createPortMaterials = (renderer: THREE.WebGLRenderer): PortMaterials => {
  const generated = [
    concreteColor(),
    concreteDetail(),
    metalColor(),
    metalDetail(),
    maintenanceSign(),
    steamSprite(),
  ];
  const [
    concreteMap,
    concreteRoughness,
    metalMap,
    metalRoughness,
    signMap,
    steamMap,
  ] = generated.map(({ texture }) => texture);

  const anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  for (const texture of generated.map(({ texture }) => texture)) texture.anisotropy = anisotropy;

  const ground = new THREE.MeshStandardMaterial({
    color: 0x8a9395,
    map: concreteMap,
    roughnessMap: concreteRoughness,
    bumpMap: concreteRoughness,
    bumpScale: 0.055,
    roughness: 0.93,
    metalness: 0,
  });
  const concrete = ground.clone();
  concrete.color.setHex(0x7d898c);
  concrete.bumpScale = 0.035;
  const concreteDark = ground.clone();
  concreteDark.color.setHex(0x49565a);
  concreteDark.roughness = 0.98;

  const paintedMetal = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: metalMap,
    roughnessMap: metalRoughness,
    bumpMap: metalRoughness,
    bumpScale: 0.03,
    roughness: 0.62,
    metalness: 0.28,
    vertexColors: true,
  });
  const darkMetal = paintedMetal.clone();
  darkMetal.color.setHex(0x344249);
  darkMetal.roughness = 0.71;
  darkMetal.metalness = 0.42;
  darkMetal.vertexColors = false;
  const rustedMetal = paintedMetal.clone();
  rustedMetal.color.setHex(0x8f5638);
  rustedMetal.roughness = 0.82;
  rustedMetal.metalness = 0.32;
  rustedMetal.vertexColors = false;

  const safetyYellow = new THREE.MeshStandardMaterial({
    color: 0xe5a82e,
    roughness: 0.62,
    metalness: 0.12,
  });
  const safetyWhite = new THREE.MeshStandardMaterial({
    color: 0xc7d2d1,
    roughness: 0.77,
    metalness: 0.04,
  });
  const wood = new THREE.MeshStandardMaterial({
    color: 0x6d5037,
    roughness: 0.88,
    metalness: 0,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x111619,
    roughness: 0.94,
    metalness: 0.02,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x6c9daf,
    roughness: 0.16,
    metalness: 0,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    clearcoat: 0.8,
    clearcoatRoughness: 0.2,
  });
  const water = new THREE.MeshPhysicalMaterial({
    color: 0x153d4b,
    roughness: 0.16,
    metalness: 0.28,
    transparent: true,
    opacity: 0.88,
    depthWrite: true,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
  });
  const puddle = water.clone();
  puddle.color.setHex(0x1d3740);
  puddle.opacity = 0.72;
  puddle.depthWrite = false;
  puddle.polygonOffset = true;
  puddle.polygonOffsetFactor = -2;

  const emissiveOrange = new THREE.MeshStandardMaterial({
    color: 0xffb05a,
    emissive: 0xff7a21,
    emissiveIntensity: 9,
    roughness: 0.24,
    metalness: 0.05,
  });
  const emissiveCyan = new THREE.MeshStandardMaterial({
    color: 0x92f1ff,
    emissive: 0x43cfe5,
    emissiveIntensity: 7,
    roughness: 0.22,
    metalness: 0.05,
  });
  const emissiveRed = new THREE.MeshStandardMaterial({
    color: 0xff5e47,
    emissive: 0xff2415,
    emissiveIntensity: 11,
    roughness: 0.22,
    metalness: 0.05,
  });
  const sign = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: signMap,
    emissive: 0x18323a,
    emissiveIntensity: 0.6,
    roughness: 0.55,
    metalness: 0.08,
  });
  const steam = new THREE.PointsMaterial({
    color: 0xd9eff2,
    map: steamMap,
    transparent: true,
    opacity: 0.055,
    alphaTest: 0.02,
    depthWrite: false,
    size: 0.36,
    sizeAttenuation: true,
  });

  const materials: THREE.Material[] = [
    ground,
    concrete,
    concreteDark,
    paintedMetal,
    darkMetal,
    rustedMetal,
    safetyYellow,
    safetyWhite,
    wood,
    rubber,
    glass,
    water,
    puddle,
    emissiveOrange,
    emissiveCyan,
    emissiveRed,
    sign,
    steam,
  ];

  return {
    ground,
    concrete,
    concreteDark,
    paintedMetal,
    darkMetal,
    rustedMetal,
    safetyYellow,
    safetyWhite,
    wood,
    rubber,
    glass,
    water,
    puddle,
    emissiveOrange,
    emissiveCyan,
    emissiveRed,
    sign,
    steam,
    textures: generated.map(({ texture }) => texture),
    materials,
    textureMemoryBytes: generated.reduce((total, texture) => total + texture.bytes, 0),
  };
};
