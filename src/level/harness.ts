/**
 * Evidence harness for the arena.
 *
 * Boots the real engine and render pipeline with the arena mounted after it —
 * the same order and the same presentation seam as `src/main.ts`, so what
 * `tools/shoot.mjs` captures here is the arena under the shipped pipeline, not a
 * bespoke preview. The arena owns `window.__SHOT__`; this file only wires the
 * engine, the frame-ready flag and the scene-stats readout the harness reads.
 *
 * Point the shot tool at:  /src/level/harness.html
 */

import * as THREE from 'three';
import { Engine } from '../core/engine.js';
import { RenderSystem } from '../render/RenderSystem.js';
import { ArenaLevel } from './ArenaLevel.js';
import type { UpdateContext } from '../core/contracts.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas);

// Minimal input stub — there is no player controller in this harness; the arena
// is static and framed by the shot hook.
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
const arena = new ArenaLevel();

engine.add(render);
engine.add(arena);

// Expose before init so a correspondence failure (which throws in the arena's
// init) is still inspectable via window.__ARENA_CHECK__.
Object.assign(window as unknown as Record<string, unknown>, { engine, THREE, arena });

try {
  await engine.init();

  engine.renderer.info.autoReset = false;
  engine.present = (_u: UpdateContext) => {
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

  const clearEdges = (): void => { edge.clear(); requestAnimationFrame(clearEdges); };
  requestAnimationFrame(clearEdges);

  let framesSeen = 0;
  const markReady = (): void => {
    if (++framesSeen >= 12) {
      (window as unknown as { __FRAME_READY__: boolean }).__FRAME_READY__ = true;
      return;
    }
    requestAnimationFrame(markReady);
  };
  requestAnimationFrame(markReady);
} catch (err) {
  // Loud, visible failure: leave __ARENA_CHECK__ in place and surface the error.
  console.error('[arena-harness] boot failed:', err);
  (window as unknown as { __ARENA_BOOT_ERROR__: string }).__ARENA_BOOT_ERROR__ = String(err);
}
