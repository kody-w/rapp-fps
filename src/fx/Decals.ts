import * as THREE from 'three';
import type { SurfaceKind } from '../core/contracts.js';
import { random } from './RNG.js';

const MAX_DECALS = 500;
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _randomRoll = new THREE.Quaternion();
const _normal = new THREE.Vector3();
export const DECAL_SURFACE_OFFSET = 0.003;
export const DECAL_MIN_SIZE = 0.075;
export const DECAL_MAX_SIZE = 0.115;

interface DecalData {
  age: number;
  life: number;
}

export class DecalSystem {
  public mesh: THREE.InstancedMesh;
  private data: DecalData[] = [];
  public activeCount = 0;
  private material: THREE.ShaderMaterial;

  constructor(private scene: THREE.Scene) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float instanceAlpha;
        attribute float instanceHeat;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vHeat;
        void main() {
          vUv = uv;
          vAlpha = instanceAlpha;
          vHeat = instanceHeat;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vAlpha;
        varying float vHeat;
        
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }
        
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), f.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }
        
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float n = noise(p * 8.0) * 0.1 + noise(p * 16.0) * 0.05;
          float d = length(p) + n - 0.08;
          float alpha = (1.0 - smoothstep(0.5, 0.78, d)) * vAlpha;
          vec3 color = mix(vec3(0.002), vec3(0.018), smoothstep(0.12, 0.55, d));
          float ring = smoothstep(0.12, 0.3, d) * (1.0 - smoothstep(0.38, 0.62, d));
          color += vec3(0.09) * ring * vHeat;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const alphas = new Float32Array(MAX_DECALS);
    const heat = new Float32Array(MAX_DECALS);
    geometry.setAttribute('instanceAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
    geometry.setAttribute('instanceHeat', new THREE.InstancedBufferAttribute(heat, 1));

    this.mesh = new THREE.InstancedMesh(geometry, this.material, MAX_DECALS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    
    for (let i = 0; i < MAX_DECALS; i++) {
      this.data.push({ age: 0, life: 10.0 });
    }
  }

  emit(point: THREE.Vector3, normal: THREE.Vector3, kind: SurfaceKind) {
    if (kind === 'water') return;
    if (this.activeCount >= MAX_DECALS) return;
    if (!isFiniteVector(point) || !isFiniteVector(normal) || normal.lengthSq() < 0.25) {
      throw new Error('DecalSystem: impact point/normal must be finite with a non-zero normal');
    }
    
    const idx = this.activeCount++;
    
    this.data[idx].age = 0;
    this.data[idx].life = 10.0;
    
    _normal.copy(normal).normalize();
    _position.copy(point).addScaledVector(_normal, DECAL_SURFACE_OFFSET);
    _rotation.setFromUnitVectors(_zAxis, _normal);
    _randomRoll.setFromAxisAngle(_normal, random() * Math.PI * 2);
    _rotation.premultiply(_randomRoll);
    
    const s = DECAL_MIN_SIZE + random() * (DECAL_MAX_SIZE - DECAL_MIN_SIZE);
    _scale.set(s, s, 1);
    
    _matrix.compose(_position, _rotation, _scale);
    this.mesh.setMatrixAt(idx, _matrix);
    
    const alphas = this.mesh.geometry.attributes.instanceAlpha as THREE.InstancedBufferAttribute;
    const heat = this.mesh.geometry.attributes.instanceHeat as THREE.InstancedBufferAttribute;
    alphas.setX(idx, 1.0);
    heat.setX(idx, 1.0);
    alphas.needsUpdate = true;
    heat.needsUpdate = true;
    
    this.mesh.count = this.activeCount;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    let alive = 0;
    const alphas = this.mesh.geometry.attributes.instanceAlpha as THREE.InstancedBufferAttribute;
    const heat = this.mesh.geometry.attributes.instanceHeat as THREE.InstancedBufferAttribute;
    
    for (let i = 0; i < this.activeCount; i++) {
      this.data[i].age += dt;
      if (this.data[i].age < this.data[i].life) {
        if (i !== alive) {
          this.data[alive].age = this.data[i].age;
          this.data[alive].life = this.data[i].life;
          this.mesh.getMatrixAt(i, _matrix);
          this.mesh.setMatrixAt(alive, _matrix);
          alphas.setX(alive, alphas.getX(i));
          heat.setX(alive, heat.getX(i));
        }
        
        const remaining = this.data[alive].life - this.data[alive].age;
        if (remaining < 2.0) {
          alphas.setX(alive, Math.max(0, remaining / 2.0));
        }
        heat.setX(alive, Math.max(0, 1 - this.data[alive].age / 0.12));
        
        alive++;
      }
    }
    
    if (this.activeCount !== alive || alive > 0) {
      this.activeCount = alive;
      this.mesh.count = this.activeCount;
      this.mesh.instanceMatrix.needsUpdate = true;
      alphas.needsUpdate = true;
      heat.needsUpdate = true;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
  
  getActiveCount() { return this.activeCount; }
}

function isFiniteVector(vector: THREE.Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}
