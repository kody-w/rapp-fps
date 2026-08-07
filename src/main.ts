/**
 * Boot. Wires the engine, the pipeline and whatever systems are registered.
 *
 * Kept deliberately thin: everything interesting belongs to a subsystem, and
 * this file is the one place that knows the order they are added in.
 */

import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { RenderSystem } from './render/RenderSystem.js';
import { TestLevel } from './level/TestLevel.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas);

// A minimal input stub so systems can read the shape before the player
// controller lands. Replaced wholesale, not extended.
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
engine.add(render);
engine.add(new TestLevel());

await engine.init();

// The pipeline owns presentation once it is initialised.
// `renderer.info` resets on every render call, so reading it after the composer
// reports its last fullscreen pass — "1 draw call, 1 triangle" for a twenty-mesh
// scene, a plausible number that means nothing. Disabling autoReset makes the
// counters accumulate across every pass in the frame, which is the honest total
// cost of presenting one frame, and we reset it ourselves at the boundary.
engine.renderer.info.autoReset = false;
engine.present = () => {
  const info = engine.renderer.info;
  info.reset();
  render.render();
  (window as unknown as Record<string, unknown>).__SCENE_STATS__ = {
    // Totals for the WHOLE frame, scene plus post. Labelled as such so nobody
    // compares it against a scene-only figure from another engine.
    drawCallsPerFrame: info.render.calls,
    trianglesPerFrame: info.render.triangles,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    programs: info.programs?.length ?? 0,
  };
};

engine.start();

// Clear edge-triggered input after every frame, once, in one place.
const clearEdges = () => { edge.clear(); requestAnimationFrame(clearEdges); };
requestAnimationFrame(clearEdges);

// A screenshot harness needs to know the first real frame has been presented,
// not merely that the page loaded — otherwise it captures an empty buffer and
// a critic reviews a black rectangle.
let framesSeen = 0;
const markReady = () => {
  if (++framesSeen >= 12) {
    (window as unknown as { __FRAME_READY__: boolean }).__FRAME_READY__ = true;
    return;
  }
  requestAnimationFrame(markReady);
};
requestAnimationFrame(markReady);

Object.assign(window as unknown as Record<string, unknown>, { engine, THREE });
