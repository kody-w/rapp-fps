/**
 * Player evidence harness. One page that carries both kinds of proof.
 *
 * It boots the real engine, the real render pipeline and the player subsystem
 * over the calibration level with a real `PlayerInput` on the canvas, the way
 * the game would integrate the player (`main.ts` itself still ships an input
 * stub with no player), so:
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
import { RenderSystem } from '../render/RenderSystem.js';
import { PlayerCalibrationLevel } from './PlayerCalibrationLevel.js';
import { PlayerInput } from './PlayerInput.js';
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

// Real browser input on the canvas, wired as production would: mouse look, WASD,
// jump/crouch/sprint, and pointer lock REQUESTED on click. Look is armed by the
// request, not the grant, so a dispatched mousemove drives the identical delta
// path an automated acceptance run depends on. With no input the player stands
// still — exactly what the GPU-capture poses want — while the named `__SHOT__`
// poses drive the motor directly and the numeric harness builds its own motors,
// so neither is disturbed by input being live here.
const input = new PlayerInput(canvas);
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
  // Apply the player's transient view effects for the draw only, then restore
  // the authoritative pose in a finally — the same exception-safe bracket
  // RenderSystem uses for shake — so a throwing draw cannot leave the shared
  // camera dressed with bob (which the next frame would then restore as stale
  // state). window.engine.camera reports the true eye pose between frames.
  player.applyViewEffects();
  try {
    render.render();
  } finally {
    player.restoreView();
  }
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
