import * as THREE from 'three';
import type { SurfaceKind } from '../core/contracts.js';
import { random } from './RNG.js';

const MAX_PARTICLES = 4000;
export const MAX_PARTICLE_PIXELS = 8;

interface ParticleParams {
  color: THREE.Color;
  emissive: number;
  size: number;
  gravity: number;
  drag: number;
  life: number;
  count: number;
  speed: number;
}

const SURFACE_PARAMS: Record<SurfaceKind, ParticleParams> = {
  concrete: { color: new THREE.Color(0x55585a), emissive: 0, size: 0.04, gravity: 4.5, drag: 4.5, life: 0.42, count: 7, speed: 1.8 },
  metal: { color: new THREE.Color(0xffaa44), emissive: 1, size: 0.018, gravity: 15, drag: 1, life: 0.28, count: 12, speed: 7 },
  wood: { color: new THREE.Color(0x6b4423), emissive: 0, size: 0.03, gravity: 7, drag: 4, life: 0.45, count: 6, speed: 2.5 },
  sand: { color: new THREE.Color(0xb49b7a), emissive: 0, size: 0.032, gravity: 3, drag: 5, life: 0.4, count: 8, speed: 1.2 },
  glass: { color: new THREE.Color(0xddeeff), emissive: 0.35, size: 0.022, gravity: 9.8, drag: 1.5, life: 0.35, count: 12, speed: 5 },
  flesh: { color: new THREE.Color(0x650303), emissive: 0, size: 0.028, gravity: 7, drag: 4, life: 0.38, count: 6, speed: 1.8 },
  foliage: { color: new THREE.Color(0x2e6e47), emissive: 0, size: 0.03, gravity: 3, drag: 6, life: 0.5, count: 5, speed: 1.5 },
  water: { color: new THREE.Color(0x88bbee), emissive: 0.15, size: 0.03, gravity: 8, drag: 3, life: 0.3, count: 10, speed: 3 },
  dirt: { color: new THREE.Color(0x4a3c31), emissive: 0, size: 0.033, gravity: 4, drag: 5, life: 0.42, count: 6, speed: 1.5 },
  fabric: { color: new THREE.Color(0x888888), emissive: 0, size: 0.025, gravity: 2, drag: 7, life: 0.45, count: 4, speed: 1 },
};

const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();

/**
 * Soft, round procedural impact motes.
 *
 * The previous tetrahedron pool projected as opaque white triangular sheets
 * near the first-person camera. Points have no geometry silhouette, and the
 * vertex shader clamps every mote to a measured eight-pixel envelope.
 */
export class ParticleSystem {
  public readonly mesh: THREE.Points;
  public activeCount = 0;

  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 3);
  private readonly sizes = new Float32Array(MAX_PARTICLES);
  private readonly alphas = new Float32Array(MAX_PARTICLES);
  private readonly ages = new Float32Array(MAX_PARTICLES);
  private readonly lifetimes = new Float32Array(MAX_PARTICLES);
  private readonly drags = new Float32Array(MAX_PARTICLES);
  private readonly gravities = new Float32Array(MAX_PARTICLES);
  private readonly baseSizes = new Float32Array(MAX_PARTICLES);
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly scene: THREE.Scene) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('particleColor', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('particleSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('particleAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 particleColor;
        attribute float particleSize;
        attribute float particleAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float projected = particleSize * 0.5 * 1080.0
            * projectionMatrix[1][1] / max(0.1, -mvPosition.z);
          gl_PointSize = clamp(projected, 1.0, ${MAX_PARTICLE_PIXELS.toFixed(1)});
          gl_Position = projectionMatrix * mvPosition;
          vColor = particleColor;
          vAlpha = particleAlpha;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
          float alpha = (1.0 - smoothstep(0.25, 1.0, radius)) * vAlpha;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    this.mesh = new THREE.Points(geometry, this.material);
    this.mesh.name = 'impact-particles';
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  emit(point: THREE.Vector3, normal: THREE.Vector3, kind: SurfaceKind): void {
    if (this.activeCount >= MAX_PARTICLES) return;
    const params = SURFACE_PARAMS[kind] || SURFACE_PARAMS.concrete;

    _tangent.set(1, 0, 0);
    if (Math.abs(normal.x) > 0.9) _tangent.set(0, 1, 0);
    _tangent.cross(normal).normalize();
    _bitangent.crossVectors(normal, _tangent);

    for (let i = 0; i < params.count && this.activeCount < MAX_PARTICLES; i++) {
      const idx = this.activeCount++;
      const offset = idx * 3;
      this.positions[offset] = point.x;
      this.positions[offset + 1] = point.y;
      this.positions[offset + 2] = point.z;

      const theta = random() * Math.PI * 2;
      const phi = Math.acos(random());
      const sinPhi = Math.sin(phi);
      const dirX = sinPhi * Math.cos(theta);
      const dirY = Math.cos(phi);
      const dirZ = sinPhi * Math.sin(theta);
      const speed = params.speed * (0.5 + 0.5 * random());
      this.velocities[offset] = (
        _tangent.x * dirX + normal.x * dirY + _bitangent.x * dirZ
      ) * speed;
      this.velocities[offset + 1] = (
        _tangent.y * dirX + normal.y * dirY + _bitangent.y * dirZ
      ) * speed;
      this.velocities[offset + 2] = (
        _tangent.z * dirX + normal.z * dirY + _bitangent.z * dirZ
      ) * speed;

      this.ages[idx] = 0;
      this.lifetimes[idx] = params.life * (0.85 + 0.3 * random());
      this.drags[idx] = params.drag;
      this.gravities[idx] = params.gravity;
      this.baseSizes[idx] = params.size * (0.85 + 0.3 * random());
      this.sizes[idx] = this.baseSizes[idx];
      this.alphas[idx] = 1;

      const intensity = 1 + params.emissive * 3;
      this.colors[offset] = params.color.r * intensity;
      this.colors[offset + 1] = params.color.g * intensity;
      this.colors[offset + 2] = params.color.b * intensity;
    }
    this.markAttributesDirty();
    this.mesh.geometry.setDrawRange(0, this.activeCount);
  }

  update(dt: number): void {
    let alive = 0;
    for (let i = 0; i < this.activeCount; i++) {
      this.ages[i] += dt;
      if (this.ages[i] >= this.lifetimes[i]) continue;
      if (i !== alive) this.copyParticle(i, alive);

      const offset = alive * 3;
      this.velocities[offset + 1] -= this.gravities[alive] * dt;
      const drag = Math.exp(-this.drags[alive] * dt);
      this.velocities[offset] *= drag;
      this.velocities[offset + 1] *= drag;
      this.velocities[offset + 2] *= drag;
      this.positions[offset] += this.velocities[offset] * dt;
      this.positions[offset + 1] += this.velocities[offset + 1] * dt;
      this.positions[offset + 2] += this.velocities[offset + 2] * dt;

      const life = this.ages[alive] / this.lifetimes[alive];
      this.sizes[alive] = this.baseSizes[alive] * (1 - life * 0.45);
      this.alphas[alive] = (1 - life) * (1 - life);
      alive++;
    }

    this.activeCount = alive;
    this.mesh.geometry.setDrawRange(0, alive);
    this.markAttributesDirty();
  }

  reset(): void {
    this.activeCount = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private copyParticle(from: number, to: number): void {
    for (let axis = 0; axis < 3; axis++) {
      this.positions[to * 3 + axis] = this.positions[from * 3 + axis];
      this.velocities[to * 3 + axis] = this.velocities[from * 3 + axis];
      this.colors[to * 3 + axis] = this.colors[from * 3 + axis];
    }
    this.sizes[to] = this.sizes[from];
    this.alphas[to] = this.alphas[from];
    this.ages[to] = this.ages[from];
    this.lifetimes[to] = this.lifetimes[from];
    this.drags[to] = this.drags[from];
    this.gravities[to] = this.gravities[from];
    this.baseSizes[to] = this.baseSizes[from];
  }

  private markAttributesDirty(): void {
    for (const name of ['position', 'particleColor', 'particleSize', 'particleAlpha']) {
      this.mesh.geometry.attributes[name].needsUpdate = true;
    }
  }
}
