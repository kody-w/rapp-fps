import * as THREE from 'three';
import { SHELL_MAX_END_ON_PIXELS, ShellEjector } from '../ShellEjector.js';

interface Check {
  name: string;
  pass: boolean;
  detail: Record<string, unknown>;
}

const SIZE = 256;
const canvas = document.getElementById('shell') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  preserveDrawingBuffer: true,
});
renderer.setSize(SIZE, SIZE, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x202020, 1);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x332211, 2.5));
const key = new THREE.DirectionalLight(0xffffff, 4);
key.position.set(2, 3, 4);
scene.add(key);
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);

const ejector = new ShellEjector(1, -10);
scene.add(ejector.mesh);

let randomCalls = 0;
ejector.eject(
  new THREE.Vector3(0, 0, -0.14),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, -1),
  () => {
    randomCalls++;
    return 0.5;
  },
);

type MutableShell = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  spinSpeed: number;
  life: number;
  active: boolean;
  bounced: boolean;
};
const internal = ejector as unknown as { shells: MutableShell[] };
const shell = internal.shells[0];
shell.position.set(0, 0, -0.14);
shell.velocity.set(0, 0, 0);
shell.rotation.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
shell.spinSpeed = 0;
shell.life = 1;
shell.active = true;
ejector.update(0);

renderer.info.autoReset = false;
renderer.info.reset();
renderer.render(scene, camera);

const gl = renderer.getContext();
const pixels = new Uint8Array(SIZE * SIZE * 4);
gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
const background = [32, 32, 32];
let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
let brightest: [number, number, number] = [0, 0, 0];
let brightestLuma = -Infinity;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const offset = (y * SIZE + x) * 4;
    const delta = Math.max(
      Math.abs(pixels[offset] - background[0]),
      Math.abs(pixels[offset + 1] - background[1]),
      Math.abs(pixels[offset + 2] - background[2]),
    );
    if (delta < 10) continue;
    const rgb: [number, number, number] = [
      pixels[offset],
      pixels[offset + 1],
      pixels[offset + 2],
    ];
    const pixelLuma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    if (pixelLuma > brightestLuma) {
      brightest = rgb;
      brightestLuma = pixelLuma;
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
}
const width = maxX >= minX ? maxX - minX + 1 : 0;
const height = maxY >= minY ? maxY - minY + 1 : 0;
const sample = (x: number, y: number): [number, number, number] => {
  const offset = (y * SIZE + x) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
};
const center = sample(128, 128);
const luma = ([r, g, b]: readonly number[]): number => r * 0.2126 + g * 0.7152 + b * 0.0722;
const colors = ejector.mesh.geometry.attributes.color as THREE.BufferAttribute;
let minVertexLuma = Infinity;
let maxVertexLuma = -Infinity;
for (let i = 0; i < colors.count; i++) {
  const value = colors.getX(i) * 0.2126 + colors.getY(i) * 0.7152 + colors.getZ(i) * 0.0722;
  minVertexLuma = Math.min(minVertexLuma, value);
  maxVertexLuma = Math.max(maxVertexLuma, value);
}

const checks: Check[] = [
  {
    name: 'one-draw-call',
    pass: renderer.info.render.calls === 1,
    detail: { calls: renderer.info.render.calls },
  },
  {
    name: 'end-on-pixel-bound',
    pass: width > 0 && width <= SHELL_MAX_END_ON_PIXELS
      && height > 0 && height <= SHELL_MAX_END_ON_PIXELS,
    detail: { width, height, bound: SHELL_MAX_END_ON_PIXELS },
  },
  {
    name: 'dark-mouth-brass-rim',
    pass: luma(center) + 20 < brightestLuma
      && brightest[0] > brightest[1]
      && brightest[1] > brightest[2],
    detail: {
      center,
      brightest,
      centerLuma: luma(center),
      brightestLuma,
      bounds: { minX, minY, maxX, maxY },
    },
  },
  {
    name: 'asymmetric-vertex-colors',
    pass: maxVertexLuma - minVertexLuma > 0.1,
    detail: { minVertexLuma, maxVertexLuma },
  },
  {
    name: 'cosmetic-rng-contract',
    pass: randomCalls === 7,
    detail: { randomCalls, expected: 7 },
  },
];

const result = {
  status: checks.every((check) => check.pass) ? 'passed' : 'failed',
  checks,
};
Object.assign(window as unknown as Record<string, unknown>, {
  __SHELL_READY__: true,
  __SHELL_RESULT__: result,
});
