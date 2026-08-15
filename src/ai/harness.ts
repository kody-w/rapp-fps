/**
 * The enemy-AI visual harness.
 *
 * It stands up the real engine + render pipeline, a minimal lit level, and the
 * `AiSystem`, then drives a scripted player through one legible fight: the
 * enemy notices the player, telegraphs, fires, is forced out of cover by
 * damage, loses sight and searches its last-known position, and dies.
 *
 * The player path, footsteps and damage are a pure function of the fixed-step
 * tick, so a named shot can rewind the agent and deterministically replay to
 * the exact tick where a state is legible, freeze it, and pose the camera. The
 * `tools/shoot.mjs` capture then photographs a still, converged frame.
 *
 * Nothing here is on the AI's hot path; it is scaffolding for evidence.
 */

import * as THREE from 'three';
import { Engine } from '../core/engine.js';
import { RenderSystem } from '../render/RenderSystem.js';
import { Events } from '../core/contracts.js';
import type { EngineContext, System, UpdateContext } from '../core/contracts.js';
import { AiSystem } from './AiSystem.js';
import type { PlayerSample } from './AiSystem.js';
import {
  EnemyAgent, buildArena, ARENA_ENEMY_SPAWN, ARENA_ENEMY_YAW, DEFAULT_ENEMY_CONFIG,
} from './index.js';
import type {
  AiState, DamageEvent, FootstepStimulus, StepInput, Vec3,
} from './index.js';

const ENEMY_ID = 'enemy-01';

// ── The scripted scenario, a pure function of the fixed-step tick ────────────

type Key = readonly [sec: number, x: number, z: number];
const PLAYER_PATH: readonly Key[] = [
  [0.0, 0.0, 5.7], //   hidden behind pillar-c (occluded from the enemy)
  [1.9, 0.0, 5.7],
  [2.3, 0.7, 2.6], //   steps into the open lane → spotted
  [6.9, 0.7, 2.6], //   holds in the open through the engage / reposition
  [7.5, -2.6, 2.4], //  ducks behind hide-l → sight lost → search
  [60.0, -2.6, 2.4], // stays hidden
];

const STEP = DEFAULT_ENEMY_CONFIG.fixedStepSeconds;

function playerAt(sec: number): Vec3 {
  const p = PLAYER_PATH;
  if (sec <= p[0][0]) return { x: p[0][1], y: 0, z: p[0][2] };
  for (let i = 1; i < p.length; i++) {
    if (sec <= p[i][0]) {
      const [t0, x0, z0] = p[i - 1];
      const [t1, x1, z1] = p[i];
      const u = (sec - t0) / (t1 - t0);
      return { x: x0 + (x1 - x0) * u, y: 0, z: z0 + (z1 - z0) * u };
    }
  }
  const last = p[p.length - 1];
  return { x: last[1], y: 0, z: last[2] };
}

interface TickInput {
  player: PlayerSample;
  footsteps: FootstepStimulus[];
  damage: DamageEvent[];
}

function inputForTick(tick: number): TickInput {
  const sec = tick * STEP;
  const pos = playerAt(sec);
  const damage: DamageEvent[] = [];
  // One non-lethal hit forces the enemy out of cover (engage → reposition).
  if (tick === 540) damage.push({ amount: 18, sourcePosition: { x: pos.x, y: 1, z: pos.z } });
  // A lethal burst while the enemy is searching (any live state → dead).
  if (tick === 1320 || tick === 1326 || tick === 1332) {
    damage.push({ amount: 40, sourcePosition: { x: pos.x, y: 1, z: pos.z } });
  }
  return { player: { position: pos, alive: true }, footsteps: [], damage };
}

function stepInputForTick(tick: number): StepInput {
  const i = inputForTick(tick);
  return {
    target: { id: 'player', position: i.player.position, alive: i.player.alive ?? true },
    footsteps: i.footsteps.length ? i.footsteps : undefined,
    damage: i.damage.length ? i.damage : undefined,
  };
}

// The live provider reads this; the director rewrites it once per fixed step.
let livePlayer: PlayerSample = inputForTick(0).player;

// ── Engine + systems ─────────────────────────────────────────────────────────

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas);
engine.input = {
  move: { x: 0, y: 0 }, look: { x: 0, y: 0 },
  jump: false, crouch: false, sprint: false, fire: false, aim: false, reload: false,
  pressed: () => false,
};

/** A minimal lit box: a key light matching the render sun, fill, and a floor. */
class MiniLevel implements System {
  readonly name = 'level';
  private readonly disposables: Array<{ dispose(): void }> = [];
  init(ctx: EngineContext): void {
    const { scene } = ctx;
    scene.fog = new THREE.FogExp2(0x0a0d12, 0.02);

    const key = new THREE.DirectionalLight(0xfff1e0, 3.0);
    key.position.set(-8, 14, 6); // agrees with RenderSystem's SUN_DIRECTION
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 60;
    const d = 16;
    key.shadow.camera.left = -d; key.shadow.camera.right = d;
    key.shadow.camera.top = d; key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0008; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
    scene.add(key);

    scene.add(new THREE.HemisphereLight(0x9dc4ff, 0x2a2118, 0.5));
    const bounce = new THREE.PointLight(0xffa35c, 14, 24, 2);
    bounce.position.set(4, 2.4, -2);
    scene.add(bounce);

    const floorGeo = new THREE.PlaneGeometry(80, 80, 1, 1);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x30343b, roughness: 0.9, metalness: 0.0 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.disposables.push(floorGeo, floorMat);
  }
  dispose(): void { for (const d of this.disposables) d.dispose(); }
}

/** Drives the scripted scenario onto the live agent through the real seams. */
class Director implements System {
  readonly name = 'ai-harness-director';
  tick = 0;
  constructor(private readonly ai: AiSystem) {}
  fixedUpdate(_step: number, ctx: EngineContext): void {
    if (this.ai.frozen) return;
    this.tick++;
    const inp = inputForTick(this.tick);
    livePlayer = inp.player;
    for (const f of inp.footsteps) {
      ctx.bus.emit(Events.Footstep, {
        position: new THREE.Vector3(f.position.x, f.position.y, f.position.z),
        surface: 'concrete', loud: f.loud >= 1,
      });
    }
    for (const dmg of inp.damage) {
      const s = dmg.sourcePosition ?? { x: 0, y: 1, z: 0 };
      ctx.bus.emit(Events.Damage, {
        id: ENEMY_ID, amount: dmg.amount,
        point: new THREE.Vector3(s.x, s.y, s.z),
        direction: new THREE.Vector3(0, 0, 0), lethal: false,
      });
    }
  }
}

const render = new RenderSystem();
const level = new MiniLevel();
const ai = new AiSystem({
  enemyId: ENEMY_ID,
  playerProvider: () => livePlayer,
});
const director = new Director(ai);

engine.add(render);
engine.add(level);
engine.add(director); //  before ai: sets the player and emits stimuli for the tick
engine.add(ai);

await engine.init();

engine.present = (_u: UpdateContext) => {
  const info = engine.renderer.info;
  info.reset();
  render.render();
  (window as unknown as Record<string, unknown>).__SCENE_STATS__ = {
    drawCallsPerFrame: info.render.calls,
    trianglesPerFrame: info.render.triangles,
    programs: info.programs?.length ?? 0,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
  };
  (window as unknown as Record<string, unknown>).__AI_COST__ = ai.costSummary();
};

engine.renderer.info.autoReset = false;
engine.start();

// ── Capture hooks ────────────────────────────────────────────────────────────

let framesSeen = 0;
const markReady = (): void => {
  if (++framesSeen >= 12) { (window as unknown as Record<string, unknown>).__FRAME_READY__ = true; return; }
  requestAnimationFrame(markReady);
};
requestAnimationFrame(markReady);

const W = new THREE.Vector3();
function poseCamera(x: number, y: number, z: number, lx: number, ly: number, lz: number): void {
  engine.camera.position.set(x, y, z);
  engine.camera.lookAt(W.set(lx, ly, lz));
}

/**
 * Frame the enemy `e` and a second point `p` (player or last-known) from the
 * side, so the gaze/aim line between them is broadside to the camera. `side`
 * picks which flank, `dist`/`height` the standoff, `lookH` the look height.
 */
function frameLine(
  e: Vec3, p: Vec3, side: number, dist: number, height: number, lookH: number,
): void {
  const mx = (e.x + p.x) / 2;
  const mz = (e.z + p.z) / 2;
  let dx = p.x - e.x; let dz = p.z - e.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const px = dz * side; const pz = -dx * side; // perpendicular in XZ
  poseCamera(mx + px * dist, height, mz + pz * dist, mx, lookH, mz);
}

/** Camera framing per shot, computed from the agent's actual replayed pose. */
const CAMERAS: Record<string, (a: EnemyAgent) => void> = {
  patrol: (a) => poseCamera(
    a.position.x + 5.0, 4.0, a.position.z - 3.4,
    a.position.x, 1.0, a.position.z + 2.6,
  ),
  notice: (a) => frameLine(a.position, a.lastKnown, 1, 5.2, 3.0, 1.2),
  telegraph: (a) => frameLine(a.position, a.lastKnown, 1, 4.6, 2.6, 1.7),
  fire: (a) => frameLine(a.position, a.lastKnown, 1, 4.4, 2.3, 1.3),
  cover: (a) => poseCamera(
    a.position.x + 3.6, 6.0, a.position.z - 2.6,
    a.position.x + 0.4, 0.4, a.position.z + 2.4,
  ),
  search: (a) => frameLine(a.position, a.lastKnown, 1, 6.0, 4.2, 0.9),
  death: (a) => poseCamera(
    a.position.x - 1.7, 2.3, a.position.z + 2.5,
    a.position.x + 0.3, 0.2, a.position.z,
  ),
};

/** First-tick predicate that makes each shot legible, plus a settle-in dwell. */
const PREDICATE: Record<string, (a: EnemyAgent) => boolean> = {
  patrol: (a) => a.state === 'patrol' && a.tick >= 90,
  notice: (a) => a.state === 'engage',
  telegraph: (a) => a.combatPhase === 'telegraph',
  fire: (a) => a.combatPhase === 'burst',
  cover: (a) => a.state === 'reposition',
  search: (a) => a.state === 'search',
  death: (a) => a.state === 'dead',
};
const SETTLE: Record<string, number> = {
  patrol: 0, notice: 0, telegraph: 36, fire: 0, cover: 34, search: 72, death: 150,
};

function poseShot(name: string): void {
  const predicate = PREDICATE[name];
  const camera = CAMERAS[name];
  if (!predicate || !camera) { console.warn(`unknown shot "${name}"`); return; }
  ai.frozen = true;
  ai.rebuildAgent();
  const settle = SETTLE[name] ?? 0;
  const MAX = 3600;
  let matched = -1;
  for (let tick = 1; tick <= MAX; tick++) {
    ai.poseStep(stepInputForTick(tick));
    if (matched < 0 && predicate(ai.agent)) matched = tick;
    if (matched >= 0 && tick >= matched + settle) break;
  }
  camera(ai.agent);
  const a = ai.agent;
  console.log(`shot ${name}: state=${a.state as AiState} phase=${a.combatPhase} `
    + `tick=${a.tick} matched=${matched}`);
}

(window as unknown as Record<string, unknown>).__SHOT__ = (name: string) => poseShot(name);

// Resolution-independent CPU micro-benchmark: a fresh agent stepped in a tight
// loop with a representative in-view input. Averaged over many steps so the
// result does not depend on the coarse resolution of a single `now()` reading.
(window as unknown as Record<string, unknown>).__AI_BENCH__ = (steps = 60000) => {
  const arena = buildArena();
  const agent = new EnemyAgent(
    DEFAULT_ENEMY_CONFIG, arena.world, arena.cover, arena.halfExtent,
    { spawn: ARENA_ENEMY_SPAWN, yaw: ARENA_ENEMY_YAW },
  );
  const input: StepInput = {
    target: { id: 'player', position: { x: 0.7, y: 0, z: 2.6 }, alive: true },
  };
  for (let i = 0; i < 200; i++) agent.fixedStep(STEP, input); // warm the JIT
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) agent.fixedStep(STEP, input);
  const totalMs = performance.now() - t0;
  const perStepUs = (totalMs / steps) * 1000;
  return { steps, totalMs, perStepUs, perFrameUs: perStepUs * 2 };
};

Object.assign(window as unknown as Record<string, unknown>, { engine, THREE, ai });
