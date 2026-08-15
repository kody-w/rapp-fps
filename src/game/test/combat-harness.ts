import * as THREE from 'three';
import { AiSystem } from '../../ai/AiSystem.js';
import { EventBusImpl } from '../../core/bus.js';
import {
  Events,
  type DamagePayload,
  type EngineContext,
  type HitConfirmedPayload,
  type InputState,
  type PlayerStatusPayload,
  type QualityTier,
} from '../../core/contracts.js';
import type { StaticWorld } from '../../core/collision.js';
import type { BulletImpactPayload } from '../../weapons/events.js';
import { buildArena } from '../../level/arena.js';
import { buildStaticWorld } from '../../level/staticWorld.js';
import { createAiArenaBinding } from '../AiArenaAdapter.js';
import { CombatSystem } from '../CombatSystem.js';

interface Outcome {
  name: string;
  pass: boolean;
  failures: string[];
  detail: Record<string, unknown>;
}

function world(blocked: boolean): StaticWorld {
  return {
    boxes: [blocked
      ? { min: [-2, 0, -5.2], max: [2, 3, -4.8], material: 'concrete' }
      : { min: [8, 0, -5.2], max: [10, 3, -4.8], material: 'concrete' }],
    bounds: { min: [-50, -10, -50], max: [50, 50, 50] },
  };
}

function context(bus: EventBusImpl): EngineContext {
  const input: InputState = {
    move: { x: 0, y: 0 }, look: { x: 0, y: 0 },
    jump: false, crouch: false, sprint: false,
    fire: false, aim: false, reload: false,
    pressed: () => false,
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 0);
  return {
    scene: new THREE.Scene(),
    camera,
    renderer: {} as THREE.WebGLRenderer,
    time: 0,
    input,
    bus,
    quality: 'ultra' as QualityTier,
    get: () => undefined,
  };
}

function fakeEnemy(health = 20): AiSystem {
  return {
    enemyId: 'enemy-test',
    currentHealth: health,
    maxHealth: 100,
    state: 'engage',
  } as unknown as AiSystem;
}

function testPlayerImpactBecomesEnemyDamage(): Outcome {
  const failures: string[] = [];
  const bus = new EventBusImpl();
  const combat = new CombatSystem({ world: world(false) });
  combat.bindEnemy(fakeEnemy());
  const ctx = context(bus);
  const damage: DamagePayload[] = [];
  const confirms: HitConfirmedPayload[] = [];
  const offDamage = bus.on<DamagePayload>(Events.Damage, (p) => damage.push(p));
  const offConfirm = bus.on<HitConfirmedPayload>(Events.HitConfirmed, (p) => confirms.push(p));
  combat.init(ctx);

  const impact: BulletImpactPayload = {
    point: new THREE.Vector3(0, 1, -8),
    normal: new THREE.Vector3(0, 0, 1),
    material: 'flesh',
    distance: 8,
    damage: 25,
    targetId: 'enemy-test',
    source: new THREE.Vector3(0, 1.7, 0),
    direction: new THREE.Vector3(0, 0, -1),
  };
  bus.emit(Events.BulletImpact, impact);
  if (damage.length !== 1) failures.push(`expected one enemy damage event, got ${damage.length}`);
  if (damage[0]?.id !== 'enemy-test') failures.push(`damage id ${String(damage[0]?.id)} != enemy-test`);
  if (damage[0]?.lethal !== true) failures.push('25 damage against 20 health must be lethal');
  if (damage[0]?.health !== 0) failures.push(`remaining health ${String(damage[0]?.health)} != 0`);
  if (confirms.length !== 1 || confirms[0]?.lethal !== true) {
    failures.push('lethal hit-confirm was not emitted exactly once');
  }

  bus.emit(Events.BulletImpact, { ...impact, targetId: 'other' });
  if (damage.length !== 1) failures.push('an unrelated target produced enemy damage');
  combat.dispose();
  bus.emit(Events.BulletImpact, impact);
  if (damage.length !== 1) failures.push('disposed combat listener still handled impacts');
  offDamage();
  offConfirm();

  return {
    name: 'playerImpactBecomesEnemyDamage',
    pass: failures.length === 0,
    failures,
    detail: { damage: damage.length, confirms: confirms.length },
  };
}

function enemyShot(blocked: boolean): {
  damage: DamagePayload[];
  status: PlayerStatusPayload[];
  fired: number;
} {
  const bus = new EventBusImpl();
  const combat = new CombatSystem({ world: world(blocked) });
  combat.bindEnemy(fakeEnemy(100));
  const ctx = context(bus);
  const damage: DamagePayload[] = [];
  const status: PlayerStatusPayload[] = [];
  let fired = 0;
  bus.on<DamagePayload>(Events.Damage, (p) => {
    if (p.id === 'player') damage.push(p);
  });
  bus.on<PlayerStatusPayload>(Events.PlayerStatus, (p) => status.push(p));
  bus.on(Events.WeaponFired, () => { fired++; });
  combat.init(ctx);
  combat.enemySink.onFire?.({
    origin: { x: 0, y: 1.22, z: -10 },
    direction: { x: 0, y: 0, z: 1 },
    aimError: 0,
    burstIndex: 0,
    time: 1,
  });
  combat.dispose();
  return { damage, status, fired };
}

function testEnemyShotHonorsPlayerAndCover(): Outcome {
  const failures: string[] = [];
  const clear = enemyShot(false);
  const blocked = enemyShot(true);

  if (clear.fired !== 1) failures.push(`clear shot emitted ${clear.fired} fire events`);
  if (clear.damage.length !== 1) failures.push(`clear shot produced ${clear.damage.length} damage events`);
  if (clear.damage[0]?.health !== 88) {
    failures.push(`clear shot player health ${String(clear.damage[0]?.health)} != 88`);
  }
  if (clear.status.map((s) => s.health).join(',') !== '100,88') {
    failures.push(`player status sequence ${clear.status.map((s) => s.health)} != 100,88`);
  }

  if (blocked.fired !== 1) failures.push(`blocked shot emitted ${blocked.fired} fire events`);
  if (blocked.damage.length !== 0) failures.push('cover did not block the enemy shot');
  if (blocked.status.map((s) => s.health).join(',') !== '100') {
    failures.push(`blocked status sequence ${blocked.status.map((s) => s.health)} != 100`);
  }

  return {
    name: 'enemyShotHonorsPlayerAndCover',
    pass: failures.length === 0,
    failures,
    detail: {
      clearDamage: clear.damage.length,
      clearHealth: clear.damage[0]?.health,
      blockedDamage: blocked.damage.length,
    },
  };
}

function testCanonicalArenaBinding(): Outcome {
  const failures: string[] = [];
  const definition = buildArena();
  const coreWorld = buildStaticWorld(definition);
  const binding = createAiArenaBinding(definition, coreWorld);

  const expectedAiBoxes = coreWorld.boxes.filter((box) => box.max[1] > 0.01);
  if (binding.arena.world.boxes.length !== expectedAiBoxes.length) {
    failures.push('AI occluder count differs after removing ground slabs');
  }
  const expectedCover = definition.enemyCoverIds.join(',');
  const actualCover = binding.arena.cover.map((cover) => cover.id).join(',');
  if (actualCover !== expectedCover) {
    failures.push(`cover ids ${actualCover} != ${expectedCover}`);
  }
  if (binding.spawn.y !== 0) {
    failures.push(`enemy spawn y ${binding.spawn.y} is not a ground/feet coordinate`);
  }
  for (let i = 0; i < expectedAiBoxes.length; i++) {
    const core = expectedAiBoxes[i];
    const ai = binding.arena.world.boxes[i];
    const flat = [ai.min.x, ai.min.y, ai.min.z, ai.max.x, ai.max.y, ai.max.z];
    if (flat.join(',') !== [...core.min, ...core.max].join(',')) {
      failures.push(`box ${i} differs between core and AI`);
      break;
    }
  }

  return {
    name: 'canonicalArenaBinding',
    pass: failures.length === 0,
    failures,
    detail: {
      coreBoxes: coreWorld.boxes.length,
      aiOccluders: binding.arena.world.boxes.length,
      cover: binding.arena.cover.map((item) => item.id),
      spawn: binding.spawn,
      yaw: binding.yaw,
    },
  };
}

function testProductionAiOmitsDebugMarkers(): Outcome {
  const failures: string[] = [];
  const bus = new EventBusImpl();
  const ctx = context(bus);
  const definition = buildArena();
  const coreWorld = buildStaticWorld(definition);
  const binding = createAiArenaBinding(definition, coreWorld);
  const productionAi = new AiSystem({
    arena: binding.arena,
    spawn: binding.spawn,
    yaw: binding.yaw,
    renderWorld: false,
    renderMarkers: false,
  });
  productionAi.init(ctx);
  const productionNames: string[] = [];
  ctx.scene.traverse((object) => {
    if (object.name.startsWith('ai-debug-')) productionNames.push(object.name);
  });
  if (productionNames.length > 0) {
    failures.push(`production contains debug markers: ${productionNames.join(',')}`);
  }
  productionAi.dispose();

  const evidenceAi = new AiSystem({
    arena: binding.arena,
    spawn: binding.spawn,
    yaw: binding.yaw,
    renderWorld: false,
    renderMarkers: true,
  });
  evidenceAi.init(ctx);
  const evidenceNames: string[] = [];
  ctx.scene.traverse((object) => {
    if (object.name.startsWith('ai-debug-')) evidenceNames.push(object.name);
  });
  for (const expected of ['ai-debug-player-marker', 'ai-debug-last-known-marker']) {
    if (!evidenceNames.includes(expected)) {
      failures.push(`evidence mode omitted ${expected}`);
    }
  }
  evidenceAi.dispose();

  return {
    name: 'productionAiOmitsDebugMarkers',
    pass: failures.length === 0,
    failures,
    detail: { productionNames, evidenceNames },
  };
}

const tests = [
  testPlayerImpactBecomesEnemyDamage(),
  testEnemyShotHonorsPlayerAndCover(),
  testCanonicalArenaBinding(),
  testProductionAiOmitsDebugMarkers(),
];
const result = {
  status: tests.every((test) => test.pass) ? 'passed' : 'failed',
  tests,
};
Object.assign(window as unknown as Record<string, unknown>, {
  __COMBAT_RESULT__: result,
  __COMBAT_READY__: true,
});
