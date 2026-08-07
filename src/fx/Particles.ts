import * as THREE from 'three';
import type { SurfaceKind } from '../core/contracts.js';
import { random } from './RNG.js';

const MAX_PARTICLES = 4000;
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _rotation = new THREE.Quaternion();

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
  concrete: { color: new THREE.Color(0x888888), emissive: 0, size: 0.05, gravity: 9.8, drag: 2, life: 1.0, count: 8, speed: 4 },
  metal: { color: new THREE.Color(0xffaa44), emissive: 1, size: 0.03, gravity: 15, drag: 1, life: 0.4, count: 12, speed: 8 },
  wood: { color: new THREE.Color(0x6b4423), emissive: 0, size: 0.08, gravity: 9.8, drag: 3, life: 1.0, count: 6, speed: 5 },
  sand: { color: new THREE.Color(0xd2b48c), emissive: 0, size: 0.04, gravity: 9.8, drag: 4, life: 0.8, count: 10, speed: 3 },
  glass: { color: new THREE.Color(0xffffff), emissive: 0.5, size: 0.06, gravity: 9.8, drag: 1, life: 0.6, count: 15, speed: 6 },
  flesh: { color: new THREE.Color(0x8a0303), emissive: 0, size: 0.05, gravity: 9.8, drag: 2, life: 0.8, count: 8, speed: 4 },
  foliage: { color: new THREE.Color(0x2e8b57), emissive: 0, size: 0.06, gravity: 4, drag: 5, life: 1.2, count: 5, speed: 2 },
  water: { color: new THREE.Color(0xaaccff), emissive: 0.2, size: 0.08, gravity: 9.8, drag: 2, life: 0.5, count: 15, speed: 5 },
  dirt: { color: new THREE.Color(0x4a3c31), emissive: 0, size: 0.05, gravity: 9.8, drag: 3, life: 1.0, count: 8, speed: 4 },
  fabric: { color: new THREE.Color(0xaaaaaa), emissive: 0, size: 0.04, gravity: 2, drag: 6, life: 1.5, count: 5, speed: 2 },
};

const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();

export class ParticleSystem {
  public mesh: THREE.InstancedMesh;
  private colors: Float32Array;
  private positions = new Float32Array(MAX_PARTICLES * 3);
  private velocities = new Float32Array(MAX_PARTICLES * 3);
  private ages = new Float32Array(MAX_PARTICLES);
  private lifetimes = new Float32Array(MAX_PARTICLES);
  private drags = new Float32Array(MAX_PARTICLES);
  private gravities = new Float32Array(MAX_PARTICLES);
  private baseSizes = new Float32Array(MAX_PARTICLES);
  public activeCount = 0;
  
  private material: THREE.ShaderMaterial;

  constructor(private scene: THREE.Scene) {
    const geometry = new THREE.TetrahedronGeometry(1);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    geometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(this.colors, 3));

    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 instanceColor;
        varying vec3 vColor;
        void main() {
          vColor = instanceColor;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          gl_FragColor = vec4(vColor, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.material, MAX_PARTICLES);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  emit(point: THREE.Vector3, normal: THREE.Vector3, kind: SurfaceKind) {
    if (this.activeCount >= MAX_PARTICLES) return;
    
    const params = SURFACE_PARAMS[kind] || SURFACE_PARAMS.concrete;
    const count = params.count;
    
    _tangent.set(1, 0, 0);
    if (Math.abs(normal.x) > 0.9) _tangent.set(0, 1, 0);
    _tangent.cross(normal).normalize();
    _bitangent.crossVectors(normal, _tangent);

    for (let i = 0; i < count; i++) {
      if (this.activeCount >= MAX_PARTICLES) break;
      const idx = this.activeCount++;
      
      this.positions[idx * 3] = point.x;
      this.positions[idx * 3 + 1] = point.y;
      this.positions[idx * 3 + 2] = point.z;

      const u = random();
      const v = random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(v);
      const sinPhi = Math.sin(phi);
      
      const dirX = sinPhi * Math.cos(theta);
      const dirY = Math.cos(phi);
      const dirZ = sinPhi * Math.sin(theta);
      
      const speed = params.speed * (0.5 + 0.5 * random());
      this.velocities[idx * 3] = (_tangent.x * dirX + normal.x * dirY + _bitangent.x * dirZ) * speed;
      this.velocities[idx * 3 + 1] = (_tangent.y * dirX + normal.y * dirY + _bitangent.y * dirZ) * speed;
      this.velocities[idx * 3 + 2] = (_tangent.z * dirX + normal.z * dirY + _bitangent.z * dirZ) * speed;

      this.ages[idx] = 0;
      this.lifetimes[idx] = params.life * (0.8 + 0.4 * random());
      this.drags[idx] = params.drag;
      this.gravities[idx] = params.gravity;
      this.baseSizes[idx] = params.size * (0.8 + 0.4 * random());

      const c = params.color;
      const m = 1.0 + params.emissive * 5.0;
      this.colors[idx * 3] = c.r * m;
      this.colors[idx * 3 + 1] = c.g * m;
      this.colors[idx * 3 + 2] = c.b * m;
    }
    
    this.mesh.geometry.attributes.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    let alive = 0;
    
    for (let i = 0; i < this.activeCount; i++) {
      this.ages[i] += dt;
      if (this.ages[i] < this.lifetimes[i]) {
        if (i !== alive) {
          for(let j=0; j<3; j++) {
            this.positions[alive * 3 + j] = this.positions[i * 3 + j];
            this.velocities[alive * 3 + j] = this.velocities[i * 3 + j];
            this.colors[alive * 3 + j] = this.colors[i * 3 + j];
          }
          this.ages[alive] = this.ages[i];
          this.lifetimes[alive] = this.lifetimes[i];
          this.drags[alive] = this.drags[i];
          this.gravities[alive] = this.gravities[i];
          this.baseSizes[alive] = this.baseSizes[i];
        }
        
        this.velocities[alive * 3 + 1] -= this.gravities[alive] * dt;
        const drag = Math.exp(-this.drags[alive] * dt);
        this.velocities[alive * 3] *= drag;
        this.velocities[alive * 3 + 1] *= drag;
        this.velocities[alive * 3 + 2] *= drag;
        
        this.positions[alive * 3] += this.velocities[alive * 3] * dt;
        this.positions[alive * 3 + 1] += this.velocities[alive * 3 + 1] * dt;
        this.positions[alive * 3 + 2] += this.velocities[alive * 3 + 2] * dt;
        
        const lifeRatio = this.ages[alive] / this.lifetimes[alive];
        const s = this.baseSizes[alive] * (1.0 - lifeRatio * lifeRatio);
        _position.set(this.positions[alive*3], this.positions[alive*3+1], this.positions[alive*3+2]);
        _scale.set(s, s, s);
        _rotation.identity();
        _matrix.compose(_position, _rotation, _scale);
        this.mesh.setMatrixAt(alive, _matrix);
        
        alive++;
      }
    }
    
    this.activeCount = alive;
    this.mesh.count = this.activeCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
