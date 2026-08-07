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
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vUv = uv;
          vAlpha = instanceAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vAlpha;
        
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
          float n = noise(p * 8.0) * 0.2 + noise(p * 16.0) * 0.1;
          float d = length(p) + n - 0.15;
          float alpha = smoothstep(0.8, 0.6, d) * vAlpha;
          vec3 color = mix(vec3(0.0), vec3(0.15), smoothstep(0.1, 0.5, d));
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
    geometry.setAttribute('instanceAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

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
    
    const idx = this.activeCount++;
    
    this.data[idx].age = 0;
    this.data[idx].life = 10.0;
    
    _position.copy(point);
    _rotation.setFromUnitVectors(_zAxis, normal);
    _randomRoll.setFromAxisAngle(normal, random() * Math.PI * 2);
    _rotation.premultiply(_randomRoll);
    
    const s = 0.15 + random() * 0.1;
    _scale.set(s, s, s);
    
    _matrix.compose(_position, _rotation, _scale);
    this.mesh.setMatrixAt(idx, _matrix);
    
    const alphas = this.mesh.geometry.attributes.instanceAlpha as THREE.InstancedBufferAttribute;
    alphas.setX(idx, 1.0);
    alphas.needsUpdate = true;
    
    this.mesh.count = this.activeCount;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    let alive = 0;
    const alphas = this.mesh.geometry.attributes.instanceAlpha as THREE.InstancedBufferAttribute;
    
    for (let i = 0; i < this.activeCount; i++) {
      this.data[i].age += dt;
      if (this.data[i].age < this.data[i].life) {
        if (i !== alive) {
          this.data[alive].age = this.data[i].age;
          this.data[alive].life = this.data[i].life;
          this.mesh.getMatrixAt(i, _matrix);
          this.mesh.setMatrixAt(alive, _matrix);
          alphas.setX(alive, alphas.getX(i));
        }
        
        const remaining = this.data[alive].life - this.data[alive].age;
        if (remaining < 2.0) {
          alphas.setX(alive, Math.max(0, remaining / 2.0));
        }
        
        alive++;
      }
    }
    
    if (this.activeCount !== alive || alive > 0) {
      this.activeCount = alive;
      this.mesh.count = this.activeCount;
      this.mesh.instanceMatrix.needsUpdate = true;
      alphas.needsUpdate = true;
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
