import * as THREE from 'three';
import { Engine } from '../core/engine.js';
import { RenderSystem } from '../render/RenderSystem.js';
import { TestLevel } from '../level/TestLevel.js';
import { CombatFX } from './CombatFX.js';
import {
  DECAL_MAX_SIZE,
  DECAL_MIN_SIZE,
  DECAL_SURFACE_OFFSET,
} from './Decals.js';
import { MAX_PARTICLE_PIXELS } from './Particles.js';
import { setSeed, random } from './RNG.js';
import { Events } from '../core/contracts.js';
import type { SurfaceKind, UpdateContext, EngineContext, System } from '../core/contracts.js';

const SURFACES: SurfaceKind[] = ['concrete', 'metal', 'wood', 'sand', 'glass', 'flesh', 'foliage', 'water', 'dirt', 'fabric'];
let activeShot = '';
let shotFrame = 0;
let sustainedLoad = true;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas);

const held = new Set<string>();
const edge = new Set<string>();
engine.input = {
  move: { x: 0, y: 0 },
  look: { x: 0, y: 0 },
  jump: false, crouch: false, sprint: false,
  fire: false, aim: false, reload: false,
  pressed: (a: string) => edge.has(a),
};
addEventListener('keydown', (e) => { if (!held.has(e.code)) edge.add(e.code); held.add(e.code); });
addEventListener('keyup', (e) => held.delete(e.code));

const render = new RenderSystem();
const level = new TestLevel();
const fx = new CombatFX();

class LoadGenerator implements System {
  readonly name = 'load-gen';
  update(_u: UpdateContext, ctx: EngineContext): void {
    if (sustainedLoad) {
      for (let i = 0; i < 10; i++) {
        const px = -2 + (random() * 8 - 4);
        const py = 1.7 + (random() * 3 - 1.5);
        ctx.bus.emit(Events.BulletImpact, {
          point: new THREE.Vector3(px, py, -12.8),
          normal: new THREE.Vector3(0, 0, 1),
          material: SURFACES[Math.floor(random() * SURFACES.length)],
          distance: 10
        });
      }
    }

    shotFrame++;
    if (activeShot && activeShot !== 'stress' && activeShot !== 'sustained-fire' && !sustainedLoad) {
      if (shotFrame % 5 === 0 && SURFACES.includes(activeShot as SurfaceKind)) {
        const px = -2 + (random() * 4 - 2);
        const py = 1.7 + (random() * 2 - 1);
        ctx.bus.emit(Events.BulletImpact, {
          point: new THREE.Vector3(px, py, -12.8),
          normal: new THREE.Vector3(0, 0, 1),
          material: activeShot as SurfaceKind,
          distance: 10
        });
        ctx.bus.emit(Events.WeaponFired, {
          origin: new THREE.Vector3(px, py, -10),
          direction: new THREE.Vector3(0, 0, -1)
        });
      }
    } else if (activeShot === 'sustained-fire' && !sustainedLoad) {
      if (shotFrame % 2 === 0) {
        for (let i = 0; i < 10; i++) {
          const px = -2 + (random() * 8 - 4);
          const py = 1.7 + (random() * 3 - 1.5);
          ctx.bus.emit(Events.BulletImpact, {
            point: new THREE.Vector3(px, py, -12.8),
            normal: new THREE.Vector3(0, 0, 1),
            material: SURFACES[Math.floor(random() * SURFACES.length)],
            distance: 10
          });
        }
      }
    }
  }
}

engine.add(render);
engine.add(level);
engine.add(fx);
engine.add(new LoadGenerator());

await engine.init();

engine.renderer.info.autoReset = false;
engine.present = (_u: UpdateContext) => {
  const info = engine.renderer.info;
  info.reset();
  
  render.render();
  
  (window as any).__SCENE_STATS__ = {
    drawCallsPerFrame: info.render.calls,
    trianglesPerFrame: info.render.triangles,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    programs: info.programs?.length ?? 0,
  };
};

engine.start();

const clearEdges = () => { edge.clear(); requestAnimationFrame(clearEdges); };
requestAnimationFrame(clearEdges);

let framesSeen = 0;
const markReady = () => {
  if (++framesSeen >= 12) {
    (window as any).__FRAME_READY__ = true;
    return;
  }
  requestAnimationFrame(markReady);
};
requestAnimationFrame(markReady);

(window as any).__SHOT__ = (name: string) => {
  sustainedLoad = false;
  activeShot = name;
  shotFrame = 0;
  
  fx.reset();
  setSeed(12345);
  console.log(`Starting shot: ${name}`);
  
  if (name === 'stress') {
    runStressTest();
  }
};

function runStressTest() {
  console.log('Running stress test...');

  const fragShader = (fx.decals as any).material.fragmentShader as string;
  if (fragShader.includes('smoothstep(0.78, 0.5')) throw new Error("Shader uses invalid smoothstep");
  if (!fragShader.includes('1.0 - smoothstep(0.5, 0.78')) throw new Error("Shader missing valid smoothstep");
  const particleVertex = (fx.particles as any).material.vertexShader as string;
  if (!particleVertex.includes(`clamp(projected, 1.0, ${MAX_PARTICLE_PIXELS.toFixed(1)})`)) {
    throw new Error(`Particle shader is missing the ${MAX_PARTICLE_PIXELS}px projected-size clamp`);
  }
  if (!(fx.particles.mesh as THREE.Points).isPoints) {
    throw new Error('Impact particles regressed from soft points to geometry silhouettes');
  }
  
  const sys = (engine as any).systems as any[];
  if (sys.filter(s => s.name === 'fx').length !== 1) throw new Error("Multiple or missing FX systems");
  if (engine.get('fx') !== fx) throw new Error("FX system identity mismatch");
  
  for (let i = 0; i < 50; i++) {
    engine.bus.emit(Events.BulletImpact, { point: new THREE.Vector3(0,0,0), normal: new THREE.Vector3(0,1,0), material: 'concrete', distance: 10 });
  }
  engine.present!({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 });
  
  const initGeos = engine.renderer.info.memory.geometries;
  
  // Flash compile check
  const initProgs = engine.renderer.info.programs?.length ?? 0;
  const initTime = performance.now();
  
  engine.bus.emit(Events.WeaponFired, { origin: new THREE.Vector3(0,0,0), direction: new THREE.Vector3(1,0,0) });
  fx.update({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 }, engine as any);
  engine.present!({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 });
  
  const elapsed = performance.now() - initTime;
  const afterProgs = engine.renderer.info.programs?.length ?? 0;
  
  if (afterProgs > initProgs) throw new Error(`Program count grew on WeaponFired: ${initProgs} -> ${afterProgs}`);
  if (elapsed > 3.0) throw new Error(`First WeaponFired caused CPU spike: ${elapsed.toFixed(2)}ms`);

  for (let i = 0; i < 500; i++) {
    engine.bus.emit(Events.BulletImpact, { point: new THREE.Vector3(0,0,0), normal: new THREE.Vector3(0,1,0), material: 'metal', distance: 10 });
  }
  
  fx.update({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 }, engine as any);
  engine.present!({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 });
  
  if (fx.getParticleCount() !== 4000) throw new Error(`Expected exactly 4000 particles, got ${fx.getParticleCount()}`);
  if (fx.getDecalCount() !== 500) throw new Error(`Expected exactly 500 decals, got ${fx.getDecalCount()}`);
  
  const curGeos = engine.renderer.info.memory.geometries;
  if (curGeos > initGeos) throw new Error(`Geometry count grew from ${initGeos} to ${curGeos}`);
  
  fx.update({ dt: 15.0, elapsed: 15, frame: 0, alpha: 1 }, engine as any);
  engine.present!({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 });
  if (fx.getParticleCount() !== 0) throw new Error('Particles did not expire');
  if (fx.getDecalCount() !== 0) throw new Error('Decals did not expire');
  
  setSeed(100);
  fx.reset();
  engine.bus.emit(Events.BulletImpact, { point: new THREE.Vector3(0,0,0), normal: new THREE.Vector3(0,1,0), material: 'concrete', distance: 10 });
  fx.update({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 }, engine as any);
  const matrixA = new THREE.Matrix4();
  fx.decals.mesh.getMatrixAt(0, matrixA);
  
  setSeed(100);
  fx.reset();
  engine.bus.emit(Events.BulletImpact, { point: new THREE.Vector3(0,0,0), normal: new THREE.Vector3(0,1,0), material: 'concrete', distance: 10 });
  fx.update({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 }, engine as any);
  const matrixB = new THREE.Matrix4();
  fx.decals.mesh.getMatrixAt(0, matrixB);
  
  for(let i=0; i<16; i++) {
    if (matrixA.elements[i] !== matrixB.elements[i]) throw new Error('Determinism failed: identical seeds produced different matrices');
  }

  const decalPosition = new THREE.Vector3();
  const decalRotation = new THREE.Quaternion();
  const decalScale = new THREE.Vector3();
  matrixB.decompose(decalPosition, decalRotation, decalScale);
  if (Math.abs(decalPosition.y - DECAL_SURFACE_OFFSET) > 1e-6) {
    throw new Error(`Decal offset ${decalPosition.y} != ${DECAL_SURFACE_OFFSET}`);
  }
  const decalNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(decalRotation);
  if (decalNormal.angleTo(new THREE.Vector3(0, 1, 0)) > 1e-6) {
    throw new Error(`Decal normal misaligned: ${decalNormal.toArray()}`);
  }
  if (decalScale.x < DECAL_MIN_SIZE || decalScale.x > DECAL_MAX_SIZE) {
    throw new Error(`Decal size ${decalScale.x} outside ${DECAL_MIN_SIZE}..${DECAL_MAX_SIZE}`);
  }
  let refusedInvalid = false;
  try {
    fx.decals.emit(new THREE.Vector3(), new THREE.Vector3(), 'concrete');
  } catch {
    refusedInvalid = true;
  }
  if (!refusedInvalid) throw new Error('Decal accepted a zero impact normal');

  fx.reset();
  engine.bus.emit(Events.WeaponFired, { origin: new THREE.Vector3(0,0,0), direction: new THREE.Vector3(1,0,0) });
  fx.update({ dt: 0.25, elapsed: 0, frame: 0, alpha: 1 }, engine as any);
  if (!(fx.flash as any).light.intensity) throw new Error('Muzzle flash expired before first render frame');
  
  engine.present!({ dt: 0.25, elapsed: 0, frame: 0, alpha: 1 });
  fx.update({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 }, engine as any);
  if ((fx.flash as any).light.intensity > 0) throw new Error('Muzzle flash did not expire after render');

  console.log('Stress test passed.');
  (window as any).STRESS_PASSED = true;
}

Object.assign(window as any, { engine, THREE, fx });
