/**
 * Evidence harness for the Foundry arena (Mission 3).
 *
 * Boots the real engine and the SHARED render pipeline with the SHARED
 * `ArenaLevel` mounted around the Foundry definition — the same order and the
 * same presentation seam as `src/main.ts`, so `tools/shoot.mjs` captures the
 * mission under the shipped pipeline, not a bespoke preview. The level owns
 * `window.__SHOT__` and runs the render⇄collision correspondence proof against
 * the real merged GPU buffers in its `init` (publishing `window.__ARENA_CHECK__`
 * and throwing on any mismatch), so this file only wires the engine, the
 * frame-ready flag and the scene-stats readout.
 *
 * Point the shot tool / correspondence verifier at:
 *   /src/level/missions/foundry/harness.html
 */

import * as THREE from 'three';
import { Engine } from '../../../core/engine.js';
import { RenderSystem } from '../../../render/RenderSystem.js';
import { createFoundryLevel } from './index.js';
import type { UpdateContext } from '../../../core/contracts.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas);

// Minimal input stub — the arena is static and framed by the shot hook.
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
const { level, definition, staticWorld } = createFoundryLevel();

engine.add(render);
engine.add(level);

// Expose before init so a correspondence failure (which throws in the level's
// init) is still inspectable via window.__ARENA_CHECK__.
Object.assign(window as unknown as Record<string, unknown>, {
  engine, THREE, arena: level,
  __FOUNDRY_DEF__: {
    mission: definition.mission,
    playerSpawns: definition.playerSpawns,
    enemySpawn: definition.enemySpawn,
    finalObjective: definition.finalObjective,
    routeWaypoints: definition.routeWaypoints,
    collidableBoxes: staticWorld.boxes.length,
  },
});

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
  console.error('[foundry-harness] boot failed:', err);
  (window as unknown as { __ARENA_BOOT_ERROR__: string }).__ARENA_BOOT_ERROR__ = String(err);
}
