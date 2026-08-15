/**
 * Foundry lifecycle fixture (Mission 3, issue #73).
 *
 * Proves the SHARED `ArenaLevel` composes, runs and tears down cleanly around
 * the Foundry definition, repeatably — init → update → dispose twice against a
 * real WebGL renderer — with the render⇄collision correspondence passing on
 * BOTH inits and the scene returning to its baseline (no leaked meshes, lights
 * or `window.__*` hooks) after each dispose. Publishes `window.__FOUNDRY_LIFECYCLE__`.
 *
 * `.mjs` runtime glue (excluded from `tsc`); Vite transforms the imported `.ts`.
 */

import { Engine } from '../../../../core/engine.js';
import { RenderSystem } from '../../../../render/RenderSystem.js';
import { ArenaLevel } from '../../../ArenaLevel.js';
import { buildStaticWorld } from '../../../staticWorld.js';
import { buildFoundry } from '../foundry.js';
import { createFoundryLevel } from '../index.js';

const out = window;
const HOOK_KEYS = ['__SHOT__', '__SHOT_LIST__', '__ARENA_CHECK__', '__LEVEL_STATIC_WORLD__', '__ARENA_SPAWNS__', '__CONTACT_SHADOWS__', '__CONTAINER_DRESSING__'];

const anyHooksPresent = () => HOOK_KEYS.some((k) => k in out && out[k] !== undefined);

function runCycle(engine, baselineChildren, makeLevel) {
  const level = makeLevel();

  // Capture an init throw as DATA (never let it escape): a regression in the
  // container-dressing guard must surface as a failed assertion, not a harness
  // crash. `initError` is retained for the evidence report.
  let initThrew = false;
  let initError = null;
  try {
    level.init(engine.context);
  } catch (err) {
    initThrew = true;
    initError = err instanceof Error ? err.message : String(err);
  }

  const afterInitChildren = engine.scene.children.length;
  const report = level.correspondence;
  const correspondenceOk = !initThrew && !!(report && report.ok);
  const hooksInstalled = !initThrew && anyHooksPresent();

  // A few presentation updates (beacon pulse) — must not throw.
  let updateThrew = false;
  if (!initThrew) {
    try {
      for (let i = 0; i < 5; i++) {
        level.update({ dt: 1 / 60, elapsed: i / 60, frame: i, alpha: 0 });
      }
    } catch {
      updateThrew = true;
    }
  }

  // Dispose must be safe even after a failed init (defensive teardown).
  try { level.dispose(); } catch { /* swallow — measured via returnedToBaseline */ }
  const afterDisposeChildren = engine.scene.children.length;
  const hooksCleared = !anyHooksPresent();

  return {
    initThrew,
    initError,
    correspondenceOk,
    correspondenceBoxCount: report ? report.boxCount : null,
    correspondenceCollidable: report ? report.collidableCount : null,
    hooksInstalled,
    hooksCleared,
    updateThrew,
    childrenBaseline: baselineChildren,
    childrenAfterInit: afterInitChildren,
    childrenAfterDispose: afterDisposeChildren,
    returnedToBaseline: afterDisposeChildren === baselineChildren,
    addedChildren: afterInitChildren - baselineChildren,
  };
}

try {
  const canvas = document.getElementById('game');
  const engine = new Engine(canvas);
  engine.input = {
    move: { x: 0, y: 0 }, look: { x: 0, y: 0 },
    jump: false, crouch: false, sprint: false, fire: false, aim: false, reload: false,
    pressed: () => false,
  };
  const render = new RenderSystem();
  engine.add(render);
  await engine.init();

  const baseline = engine.scene.children.length;
  const makeDressingFalse = () => {
    const def = buildFoundry();
    const world = buildStaticWorld(def);
    return new ArenaLevel(def, world, { containerDressing: false });
  };
  const cycle1 = runCycle(engine, baseline, makeDressingFalse);
  const cycle2 = runCycle(engine, baseline, makeDressingFalse);

  // Reproducing gate for the container-dressing guard: a caller passing an
  // EXPLICIT `undefined` through the public seam must NOT re-open the throwing
  // default-on dressing path. Pre-fix (spread over a `false` default) this init
  // threw `Cannot read properties of undefined (reading 'index')`; post-fix
  // (`options.containerDressing ?? false`) it inits, corresponds, and tears down.
  const undefinedDressingCycle = runCycle(
    engine, baseline, () => createFoundryLevel({ containerDressing: undefined }).level,
  );

  const ok = [cycle1, cycle2].every((c) =>
    c.correspondenceOk && c.hooksInstalled && c.hooksCleared
    && !c.updateThrew && c.returnedToBaseline && c.addedChildren > 0)
    && !undefinedDressingCycle.initThrew
    && undefinedDressingCycle.correspondenceOk
    && undefinedDressingCycle.returnedToBaseline;

  out.__FOUNDRY_LIFECYCLE__ = {
    at: new Date().toISOString(),
    ok,
    baselineChildren: baseline,
    cycles: [cycle1, cycle2],
    undefinedDressingCycle,
    assertions: [
      { name: 'cycle1_correspondence_ok', passed: cycle1.correspondenceOk },
      { name: 'cycle2_correspondence_ok', passed: cycle2.correspondenceOk },
      { name: 'both_installed_hooks', passed: cycle1.hooksInstalled && cycle2.hooksInstalled },
      { name: 'both_cleared_hooks_on_dispose', passed: cycle1.hooksCleared && cycle2.hooksCleared },
      { name: 'no_update_throw', passed: !cycle1.updateThrew && !cycle2.updateThrew },
      { name: 'scene_returns_to_baseline', passed: cycle1.returnedToBaseline && cycle2.returnedToBaseline },
      { name: 'undefined_dressing_option_safe', passed: !undefinedDressingCycle.initThrew && undefinedDressingCycle.correspondenceOk && undefinedDressingCycle.returnedToBaseline },
    ],
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__FOUNDRY_LIFECYCLE_ERROR__ = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  out.__FRAME_READY__ = true;
}
