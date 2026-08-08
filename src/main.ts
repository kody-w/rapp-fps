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
import { CombatFX } from './fx/CombatFX.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { CombatHud } from './hud/CombatHud.js';

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
const onKeyDown = (event: KeyboardEvent): void => {
  if (!held.has(event.code)) edge.add(event.code);
  held.add(event.code);
};
const onKeyUp = (event: KeyboardEvent): void => { held.delete(event.code); };
addEventListener('keydown', onKeyDown);
addEventListener('keyup', onKeyUp);

const render = new RenderSystem();
const fx = new CombatFX();
const audio = new AudioSystem();
const hud = new CombatHud({
  playerId: 'player',
  profiler: {
    snapshot: () => engine.profiler.snapshot(),
    drawCalls: () => {
      const stats = (window as unknown as {
        __SCENE_STATS__?: { drawCallsPerFrame?: number };
      }).__SCENE_STATS__;
      return stats?.drawCallsPerFrame ?? null;
    },
  },
});

// Development-only mutation seam for the integration verifier. Production
// builds always register all three; Vite folds `import.meta.env.DEV` to false.
const integrationOmit = import.meta.env.DEV
  ? new URLSearchParams(location.search).get('integrationOmit')
  : null;
const enabled = (name: 'fx' | 'audio' | 'hud'): boolean => integrationOmit !== name;

engine.add(render);
engine.add(new TestLevel());
if (enabled('fx')) engine.add(fx);
if (enabled('audio')) engine.add(audio);
if (enabled('hud')) engine.add(hud);

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

// Web Audio may only start from a real user gesture. Keep the listeners until
// arming actually succeeds; reattach them if the context later becomes
// suspended/interrupted. The whole composition is gated when audio is omitted
// by the integration mutation, not only its engine registration.
let audioArmListenersAttached = false;
const removeAudioArmListeners = (): void => {
  if (!audioArmListenersAttached) return;
  removeEventListener('pointerdown', armAudio);
  removeEventListener('keydown', armAudio);
  audioArmListenersAttached = false;
};
const addAudioArmListeners = (): void => {
  if (audioArmListenersAttached || !enabled('audio')) return;
  addEventListener('pointerdown', armAudio);
  addEventListener('keydown', armAudio);
  audioArmListenersAttached = true;
};
const armAudio = (): void => {
  if (!enabled('audio')) return;
  void audio.arm().then((armed) => {
    document.documentElement.dataset.audio = audio.status.state;
    if (armed) {
      if (enabled('hud')) hud.setInteraction(null);
      removeAudioArmListeners();
    }
  });
};

let unsubscribeAudioStatus = (): void => {};
if (enabled('audio')) {
  if (enabled('hud')) hud.setInteraction({ action: 'ENABLE AUDIO', binding: 'CLICK' });
  addAudioArmListeners();
  unsubscribeAudioStatus = audio.subscribeStatus((status) => {
    document.documentElement.dataset.audio = status.state;
    if (status.state === 'armed') {
      removeAudioArmListeners();
      if (enabled('hud')) hud.setInteraction(null);
      return;
    }
    if (
      status.state === 'unarmed'
      || status.state === 'suspended'
      || status.state === 'interrupted'
    ) {
      addAudioArmListeners();
      if (enabled('hud')) {
        hud.setInteraction({
          action: status.state === 'unarmed' ? 'ENABLE AUDIO' : 'RESUME AUDIO',
          binding: 'CLICK',
        });
      }
      return;
    }
    if (status.state === 'unavailable' || status.state === 'closed') {
      removeAudioArmListeners();
      if (enabled('hud')) hud.setInteraction({ action: 'AUDIO UNAVAILABLE', binding: '' });
    }
  });
} else {
  document.documentElement.dataset.audio = 'omitted';
}

// Clear edge-triggered input after every frame, once, in one place.
let clearEdgesRaf = 0;
const clearEdges = () => {
  edge.clear();
  clearEdgesRaf = requestAnimationFrame(clearEdges);
};
clearEdgesRaf = requestAnimationFrame(clearEdges);

// A screenshot harness needs to know the first real frame has been presented,
// not merely that the page loaded — otherwise it captures an empty buffer and
// a critic reviews a black rectangle.
let framesSeen = 0;
let readyRaf = 0;
const markReady = () => {
  if (++framesSeen >= 12) {
    (window as unknown as { __FRAME_READY__: boolean }).__FRAME_READY__ = true;
    readyRaf = 0;
    return;
  }
  readyRaf = requestAnimationFrame(markReady);
};
readyRaf = requestAnimationFrame(markReady);

let disposed = false;
const disposeApp = (): void => {
  if (disposed) return;
  disposed = true;
  removeAudioArmListeners();
  unsubscribeAudioStatus();
  removeEventListener('keydown', onKeyDown);
  removeEventListener('keyup', onKeyUp);
  if (clearEdgesRaf) cancelAnimationFrame(clearEdgesRaf);
  if (readyRaf) cancelAnimationFrame(readyRaf);
  engine.dispose();
};

Object.assign(window as unknown as Record<string, unknown>, {
  engine,
  THREE,
  __INTEGRATION__: { fx, audio, hud, dispose: disposeApp },
});

addEventListener('pagehide', (event) => {
  // A persisted pagehide enters BFCache. Disposing here returns a dead app on
  // pageshow; the browser freezes/resumes the existing object graph for us.
  if (!event.persisted) disposeApp();
});
