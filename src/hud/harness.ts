import { Engine } from '../core/engine.js';
import type { InputState } from '../core/contracts.js';
import { TestLevel } from '../level/TestLevel.js';
import { RenderSystem } from '../render/RenderSystem.js';
import {
  CombatHud,
  HudEvents,
  type CharacterId,
  type DamageScreenDirection,
  type Vector3Like,
} from './CombatHud.js';

export const SHOT_STATES = [
  'hip',
  'ads',
  'reload',
  'damaged-left',
  'low-health',
  'hit-confirm',
  'objective',
] as const;

export type ShotState = typeof SHOT_STATES[number];

interface HudDamageSnapshot {
  health: string;
  indicatorVisible: boolean;
  quadrant: string | null;
  angle: string;
}

interface LifecycleSnapshot {
  rootCount: number;
  nodeCount: number;
  ammo: string;
  health: string;
  reticle: string | undefined;
  objective: string;
}

interface HudHarness {
  setState(name: ShotState): Promise<void>;
  stressUpdates(count: number): Promise<{ before: number; after: number }>;
  nodeCount(): number;
  mapDamage(direction: Vector3Like, cameraYawRadians?: number): Promise<DamageScreenDirection>;
  emitDamage(
    id: CharacterId,
    direction: Vector3Like,
    health?: number,
  ): Promise<HudDamageSnapshot>;
  emitElimination(label?: string): Promise<void>;
  emitReloadStart(): Promise<void>;
  remount(): Promise<LifecycleSnapshot>;
  waitFrames(count: number): Promise<void>;
}

declare global {
  interface Window {
    __FRAME_READY__: boolean;
    __HUD_HARNESS__: HudHarness;
  }
}

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Harness canvas is missing');

const engine = new Engine(canvas);
const input: InputState = {
  move: { x: 0, y: 0 },
  look: { x: 0, y: 0 },
  jump: false,
  crouch: false,
  sprint: false,
  fire: false,
  aim: false,
  reload: false,
  pressed: () => false,
};
engine.input = input;

let drawCalls = 0;
const render = new RenderSystem();
const params = new URLSearchParams(location.search);
const PLAYER_ID = 'player-local';
const noReuseMutationControl = params.get('mutation') === 'no-reuse';
const hud = new CombatHud({
  playerId: PLAYER_ID,
  query: location.search,
  profiler: {
    snapshot: () => engine.profiler.snapshot(),
    drawCalls: () => drawCalls,
    budgetMs: 16.7,
  },
});

engine.add(render);
engine.add(new TestLevel());
engine.add(hud);
await engine.init();

function appendHarnessMutationNode(): void {
  const root = document.querySelector('[data-hud-root]');
  if (!root) throw new Error('HUD root is missing');
  const leaked = document.createElement('i');
  leaked.hidden = true;
  leaked.dataset.harnessMutation = 'no-reuse';
  root.append(leaked);
}

if (noReuseMutationControl) {
  // Seed the harness-only negative control with the two discarded initial renders.
  appendHarnessMutationNode();
  appendHarnessMutationNode();
}

engine.renderer.info.autoReset = false;
engine.present = () => {
  const info = engine.renderer.info;
  info.reset();
  render.render();
  drawCalls = info.render.calls;
};
engine.start();

function waitFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (): void => {
      if (--count <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function resetState(): void {
  engine.camera.rotation.set(-0.06, 0, 0);
  engine.camera.updateMatrixWorld();
  hud.resetFeedback();
  hud.setWeaponStatus({
    ammo: 24,
    reserve: 96,
    magazineSize: 30,
    reloading: false,
    spread: 0.62,
    aim: 0,
  });
  hud.setPlayerStatus({ health: 100, maxHealth: 100 });
  hud.setObjective(null);
  hud.setInteraction(null);
}

async function setState(name: ShotState): Promise<void> {
  resetState();
  switch (name) {
    case 'hip':
      break;
    case 'ads':
      engine.bus.emit('weapon:aim', { aiming: true, t: 1 });
      hud.setWeaponStatus({ spread: 0.06 });
      break;
    case 'reload':
      hud.setWeaponStatus({ ammo: 7, reserve: 72, spread: 0.48 });
      engine.bus.emit('weapon:reload-start');
      break;
    case 'damaged-left':
      engine.bus.emit('combat:damage', {
        id: PLAYER_ID,
        amount: 28,
        health: 72,
        maxHealth: 100,
        direction: { x: -1, y: 0, z: 0 },
      });
      break;
    case 'low-health':
      hud.setPlayerStatus({ health: 18, maxHealth: 100 });
      hud.setWeaponStatus({ ammo: 5, reserve: 18 });
      break;
    case 'hit-confirm':
      engine.bus.emit(HudEvents.HitConfirmed, { lethal: false });
      break;
    case 'objective':
      engine.bus.emit(HudEvents.ObjectiveChanged, {
        title: 'SECURE THE RELAY',
        detail: 'UPLINK 02 · WEST ATRIUM',
      });
      engine.bus.emit(HudEvents.InteractionChanged, {
        binding: 'E',
        action: 'HOLD TO OVERRIDE',
      });
      break;
  }
  await waitFrames(2);
}

function nodeCount(): number {
  const root = document.querySelector('[data-hud-root]');
  if (!root) throw new Error('HUD root is missing');
  return root.querySelectorAll('*').length;
}

async function stressUpdates(count: number): Promise<{ before: number; after: number }> {
  const before = nodeCount();
  for (let i = 0; i < count; i++) {
    hud.setWeaponStatus({
      ammo: i % 31,
      reserve: 120 - i % 61,
      spread: (i % 101) / 100,
      aim: (i % 2),
    });
    if (noReuseMutationControl) appendHarnessMutationNode();
  }
  await waitFrames(2);
  return { before, after: nodeCount() };
}

async function mapDamage(
  direction: Vector3Like,
  cameraYawRadians = 0,
): Promise<DamageScreenDirection> {
  engine.camera.rotation.set(0, cameraYawRadians, 0);
  engine.camera.updateMatrixWorld();
  const result = await emitDamage(PLAYER_ID, direction);
  if (!result.quadrant) throw new Error('Damage indicator was not presented');
  const indicator = document.querySelector<HTMLElement>('.hud-damage');
  if (!indicator) throw new Error('Damage indicator is missing');
  const angleDeg = Number.parseFloat(indicator.style.getPropertyValue('--damage-angle'));
  return {
    angleDeg,
    quadrant: result.quadrant as DamageScreenDirection['quadrant'],
  };
}

async function emitDamage(
  id: CharacterId,
  direction: Vector3Like,
  health = 100,
): Promise<HudDamageSnapshot> {
  engine.bus.emit('combat:damage', {
    id,
    amount: 0,
    health,
    maxHealth: 100,
    direction,
  });
  await waitFrames(2);
  const indicator = document.querySelector<HTMLElement>('.hud-damage');
  const healthValue = document.querySelector<HTMLElement>('.hud-health-value');
  if (!indicator || !healthValue) throw new Error('HUD damage presentation is missing');
  return {
    health: healthValue.textContent ?? '',
    indicatorVisible: indicator.classList.contains('is-visible'),
    quadrant: indicator.dataset.quadrant ?? null,
    angle: indicator.style.getPropertyValue('--damage-angle'),
  };
}

async function emitElimination(label = 'TARGET DOWN'): Promise<void> {
  engine.bus.emit(HudEvents.Elimination, { label });
  await waitFrames(2);
}

async function emitReloadStart(): Promise<void> {
  engine.bus.emit('weapon:reload-start');
  await waitFrames(2);
}

async function remount(): Promise<LifecycleSnapshot> {
  hud.setWeaponStatus({ ammo: 5, reserve: 18, spread: 0.06, aim: 1 });
  hud.setPlayerStatus({ health: 18, maxHealth: 100 });
  hud.setObjective({ title: 'LIFECYCLE CHECK', detail: 'REMOUNTED' });
  await waitFrames(2);
  hud.dispose();
  hud.init(engine.context);
  await waitFrames(2);

  const root = document.querySelector<HTMLElement>('[data-hud-root]');
  if (!root) throw new Error('HUD did not remount');
  return {
    rootCount: document.querySelectorAll('[data-hud-root]').length,
    nodeCount: root.querySelectorAll('*').length,
    ammo: root.querySelector('.hud-ammo-value')?.textContent ?? '',
    health: root.querySelector('.hud-health-value')?.textContent ?? '',
    reticle: root.dataset.reticle,
    objective: root.querySelector('.hud-objective-title')?.textContent ?? '',
  };
}

window.__HUD_HARNESS__ = {
  setState,
  stressUpdates,
  nodeCount,
  mapDamage,
  emitDamage,
  emitElimination,
  emitReloadStart,
  remount,
  waitFrames,
};
Object.assign(window as unknown as Record<string, unknown>, { engine });

const requested = params.get('state');
const initial = SHOT_STATES.find((state) => state === requested) ?? 'hip';
await setState(initial);
await waitFrames(12);
window.__FRAME_READY__ = true;
