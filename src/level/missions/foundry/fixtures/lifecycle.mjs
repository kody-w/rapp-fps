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

const out = window;
const HOOK_KEYS = ['__SHOT__', '__SHOT_LIST__', '__ARENA_CHECK__', '__LEVEL_STATIC_WORLD__', '__ARENA_SPAWNS__', '__CONTACT_SHADOWS__', '__CONTAINER_DRESSING__'];

const anyHooksPresent = () => HOOK_KEYS.some((k) => k in out && out[k] !== undefined);

function runCycle(engine, baselineChildren) {
  const def = buildFoundry();
  const world = buildStaticWorld(def);
  const level = new ArenaLevel(def, world, { containerDressing: false });

  level.init(engine.context);
  const afterInitChildren = engine.scene.children.length;
  const report = level.correspondence;
  const correspondenceOk = !!(report && report.ok);
  const hooksInstalled = anyHooksPresent();

  // A few presentation updates (beacon pulse) — must not throw.
  let updateThrew = false;
  try {
    for (let i = 0; i < 5; i++) {
      level.update({ dt: 1 / 60, elapsed: i / 60, frame: i, alpha: 0 });
    }
  } catch {
    updateThrew = true;
  }

  level.dispose();
  const afterDisposeChildren = engine.scene.children.length;
  const hooksCleared = !anyHooksPresent();

  return {
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
  const cycle1 = runCycle(engine, baseline);
  const cycle2 = runCycle(engine, baseline);

  const ok = [cycle1, cycle2].every((c) =>
    c.correspondenceOk && c.hooksInstalled && c.hooksCleared
    && !c.updateThrew && c.returnedToBaseline && c.addedChildren > 0);

  out.__FOUNDRY_LIFECYCLE__ = {
    at: new Date().toISOString(),
    ok,
    baselineChildren: baseline,
    cycles: [cycle1, cycle2],
    assertions: [
      { name: 'cycle1_correspondence_ok', passed: cycle1.correspondenceOk },
      { name: 'cycle2_correspondence_ok', passed: cycle2.correspondenceOk },
      { name: 'both_installed_hooks', passed: cycle1.hooksInstalled && cycle2.hooksInstalled },
      { name: 'both_cleared_hooks_on_dispose', passed: cycle1.hooksCleared && cycle2.hooksCleared },
      { name: 'no_update_throw', passed: !cycle1.updateThrew && !cycle2.updateThrew },
      { name: 'scene_returns_to_baseline', passed: cycle1.returnedToBaseline && cycle2.returnedToBaseline },
    ],
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__FOUNDRY_LIFECYCLE_ERROR__ = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  out.__FRAME_READY__ = true;
}
