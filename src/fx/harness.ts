import * as THREE from 'three';
import { Engine } from '../core/engine.js';
import { RenderSystem } from '../render/RenderSystem.js';
import { TestLevel } from '../level/TestLevel.js';
import { CombatFX } from './CombatFX.js';
import { setSeed } from './Particles.js';
import { Events } from '../core/contracts.js';
import type { SurfaceKind, UpdateContext } from '../core/contracts.js';

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

engine.add(render);
engine.add(level);
engine.add(fx);

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

// --- Shot Hooks ---
let activeShot = '';
let shotFrame = 0;
(window as any).__SHOT__ = (name: string) => {
  activeShot = name;
  shotFrame = 0;
  setSeed(12345);
  console.log(`Starting shot: ${name}`);
  
  if (name === 'stress') {
    runStressTest();
  }
};

const SURFACES: SurfaceKind[] = ['concrete', 'metal', 'wood', 'sand', 'glass', 'flesh', 'foliage', 'water', 'dirt', 'fabric'];

// We hook into update via EventBus or just patching engine.update?
// Actually we can just run an update listener since we have the bus, or we can patch engine.present.
const originalPresent = engine.present;
engine.present = (_u: UpdateContext) => {
  shotFrame++;
  if (activeShot && activeShot !== 'stress' && activeShot !== 'sustained-fire') {
    // Emit one impact every 5 frames so we get a trail
    if (shotFrame % 5 === 0 && SURFACES.includes(activeShot as SurfaceKind)) {
      // Wall is at z = -13 from TestLevel
      // Let's emit on the wall
      const px = -2 + (Math.random() * 4 - 2);
      const py = 1.7 + (Math.random() * 2 - 1);
      engine.bus.emit(Events.BulletImpact, {
        point: new THREE.Vector3(px, py, -12.8),
        normal: new THREE.Vector3(0, 0, 1),
        material: activeShot as SurfaceKind,
        distance: 10
      });
      engine.bus.emit(Events.WeaponFired, {
        origin: new THREE.Vector3(px, py, -10),
        direction: new THREE.Vector3(0, 0, -1)
      });
    }
  } else if (activeShot === 'sustained-fire') {
    // Emit heavily
    if (shotFrame % 2 === 0) {
      for (let i = 0; i < 10; i++) {
        const px = -2 + (Math.random() * 8 - 4);
        const py = 1.7 + (Math.random() * 3 - 1.5);
        engine.bus.emit(Events.BulletImpact, {
          point: new THREE.Vector3(px, py, -12.8),
          normal: new THREE.Vector3(0, 0, 1),
          material: SURFACES[Math.floor(Math.random() * SURFACES.length)],
          distance: 10
        });
      }
    }
  }
  originalPresent!(_u);
};

function runStressTest() {
  console.log('Running stress test...');
  // Warmup
  for (let i = 0; i < 50; i++) {
    engine.bus.emit(Events.BulletImpact, {
      point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0,1,0),
      material: 'concrete', distance: 10
    });
  }
  
  // Render one frame to compile shaders
  engine.present!({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 });
  const initGeos = engine.renderer.info.memory.geometries;
    
  console.log(`Warmup done. Geos: ${initGeos}`);
  
  // 500 impacts
  for (let i = 0; i < 500; i++) {
    engine.bus.emit(Events.BulletImpact, {
      point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0,1,0),
      material: 'metal', distance: 10
    });
  }
  
  // Update manually or render to let things process
  fx.update({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 }, engine as any);
  engine.present!({ dt: 0.1, elapsed: 0, frame: 0, alpha: 1 });
  
  const curGeos = engine.renderer.info.memory.geometries;
  
  const particleCount = fx.getParticleCount();
  const decalCount = fx.getDecalCount();
  
  console.log(`After 500 impacts. Active Particles: ${particleCount}, Active Decals: ${decalCount}, Geos: ${curGeos}`);
  
  if (particleCount > 4000) throw new Error(`Particle count ${particleCount} exceeded cap`);
  if (decalCount > 500) throw new Error(`Decal count ${decalCount} exceeded cap`);
  if (curGeos > initGeos) throw new Error(`Geometry count grew from ${initGeos} to ${curGeos}`);
  
  // Let time pass so they expire
  fx.update({ dt: 15.0, elapsed: 15, frame: 0, alpha: 1 }, engine as any);
  
  const endParticleCount = fx.getParticleCount();
  const endDecalCount = fx.getDecalCount();
  console.log(`After 15s. Active Particles: ${endParticleCount}, Active Decals: ${endDecalCount}`);
  
  if (endParticleCount !== 0) throw new Error(`Particles did not expire, count is ${endParticleCount}`);
  if (endDecalCount !== 0) throw new Error(`Decals did not expire, count is ${endDecalCount}`);
  
  console.log('Stress test passed.');
  (window as any).STRESS_PASSED = true;
}

Object.assign(window as any, { engine, THREE, fx });
