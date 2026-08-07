import { Engine } from '../core/engine.js';
import type { InputState } from '../core/contracts.js';
import { TestLevel } from '../level/TestLevel.js';
import { RenderSystem } from '../render/RenderSystem.js';
import {
  CombatHud,
  HudEvents,
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

interface HudHarness {
  setState(name: ShotState): Promise<void>;
  stressUpdates(count: number): Promise<{ before: number; after: number }>;
  nodeCount(): number;
  mapDamage(direction: Vector3Like, cameraYawRadians?: number): Promise<DamageScreenDirection>;
  emitElimination(label?: string): Promise<void>;
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
const hud = new CombatHud({
  query: location.search,
  reuseNodes: params.get('reuse') !== '0',
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
  engine.bus.emit('combat:damage', {
    amount: 0,
    health: 100,
    maxHealth: 100,
    direction,
  });
  await waitFrames(2);
  const indicator = document.querySelector<HTMLElement>('.hud-damage');
  if (!indicator?.dataset.quadrant) throw new Error('Damage indicator was not presented');
  const angleDeg = Number.parseFloat(indicator.style.getPropertyValue('--damage-angle'));
  return {
    angleDeg,
    quadrant: indicator.dataset.quadrant as DamageScreenDirection['quadrant'],
  };
}

async function emitElimination(label = 'TARGET DOWN'): Promise<void> {
  engine.bus.emit(HudEvents.Elimination, { label });
  await waitFrames(2);
}

window.__HUD_HARNESS__ = {
  setState,
  stressUpdates,
  nodeCount,
  mapDamage,
  emitElimination,
  waitFrames,
};
Object.assign(window as unknown as Record<string, unknown>, { engine });

const requested = params.get('state');
const initial = SHOT_STATES.find((state) => state === requested) ?? 'hip';
await setState(initial);
await waitFrames(12);
window.__FRAME_READY__ = true;
