/**
 * Player evidence harness. One page that carries both kinds of proof.
 *
 * It boots the real engine, the real render pipeline and the player subsystem
 * over the calibration level, wired exactly as `main.ts` wires the game, so:
 *
 *  - `tools/shoot.mjs` can capture real GPU frames and time them against the
 *    16.7 ms budget (`window.engine`, `__SCENE_STATS__`, `__FRAME_READY__`,
 *    and the named `__SHOT__` poses the player system installs), and
 *  - the Playwright motor runner can execute the deterministic numeric harness
 *    IN THIS BUNDLE — not a separate transpile — via `__PLAYER_HARNESS_API__`.
 *
 * The numeric harness (`runPlayerHarness`) is pure; it builds its own motors
 * and worlds and does not disturb the live scene, so running it mid-capture is
 * safe.
 */

import { Engine } from '../core/engine.js';
import type { InputState } from '../core/contracts.js';
import { RenderSystem } from '../render/RenderSystem.js';
import { PlayerCalibrationLevel } from './PlayerCalibrationLevel.js';
import { PlayerSystem } from './PlayerSystem.js';
import { runPlayerHarness, type PlayerHarnessReport } from './harness-report.js';

interface PlayerHarnessApi {
  run(): PlayerHarnessReport;
}

declare global {
  interface Window {
    __FRAME_READY__: boolean;
    __PLAYER_HARNESS_API__: PlayerHarnessApi;
  }
}

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Harness canvas is missing');

const engine = new Engine(canvas);

// A neutral, headless input: no pointer lock, no motion. Shot poses drive the
// player through `__SHOT__`, and the numeric harness runs the motor directly.
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

const render = new RenderSystem();
const level = new PlayerCalibrationLevel();
const player = new PlayerSystem(input, { world: level.world, spawn: level.spawn });

// Look down the arena's long axis with a slight downward tilt before the player
// reads the camera as its initial orientation.
engine.camera.rotation.set(-0.09, 0, 0, 'YXZ');

engine.add(render);
engine.add(level);
engine.add(player);
await engine.init();

engine.renderer.info.autoReset = false;
engine.present = () => {
  const info = engine.renderer.info;
  info.reset();
  render.render();
  (window as unknown as Record<string, unknown>).__SCENE_STATS__ = {
    drawCallsPerFrame: info.render.calls,
    trianglesPerFrame: info.render.triangles,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    programs: info.programs?.length ?? 0,
  };
};

engine.start();

window.__PLAYER_HARNESS_API__ = { run: () => runPlayerHarness() };
Object.assign(window as unknown as Record<string, unknown>, { engine, player });

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

const params = new URLSearchParams(location.search);
const requestedShot = params.get('shot');
if (requestedShot) player.setShotState(requestedShot);

await waitFrames(14);
window.__FRAME_READY__ = true;
