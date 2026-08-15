/**
 * RELAY BLACKOUT integrity harness (issue #72, parent #70).
 *
 * Two proofs the topology/traversal fixtures don't cover, both against the REAL
 * render path (a real `THREE.WebGLRenderer`, real merged buffers), with ZERO
 * edits to any shared file:
 *
 *  1. CORRESPONDENCE — mounts the mission through the shipping `ArenaLevel`
 *     (`new ArenaLevel(buildRelayArena(), buildStaticWorld(def), …)`), whose
 *     `init` runs `checkCorrespondence(def, world, mergedGroups)` against the
 *     exact GPU buffers it just built. We assert all five checks are green:
 *     core-contract, box-count, bijection, render-backing, render-membership —
 *     i.e. every collidable box is backed by drawn geometry and vice-versa.
 *
 *  2. LIFECYCLE / DISPOSAL — build → init → dispose → rebuild. After dispose the
 *     arena root must be gone from the scene, the `__SHOT__`/`__ARENA_CHECK__`
 *     globals cleaned up, and GPU geometry handles released; a fresh rebuild on
 *     a new scene must pass correspondence again (no leaked global state).
 *
 *  3. INTEGRATION FOOTGUN — `buildRelayArena()` declares no `container` solids,
 *     but `ArenaLevel` defaults container dressing ON, and that path throws on an
 *     empty selection (`mergeGeometries([])`). So a raw
 *     `new ArenaLevel(def, world)` with DEFAULT options CRASHES in init. This
 *     block reproduces that crash (red on the unsafe/default path) and proves
 *     `createRelayLevel()` — which resolves `containerDressing` via `?? false`,
 *     including on an explicit `undefined` — mounts cleanly (green through the
 *     factory).
 *
 * Result published on `window.__RELAY_INTEGRITY__` for the playwright runner.
 */

import * as THREE from 'three';
import { buildRelayArena } from '../relayArena.js';
import { buildStaticWorld } from '../../../staticWorld.js';
import { ArenaLevel } from '../../../ArenaLevel.js';
import { createRelayLevel } from '../relayLevel.js';

const out = window;
const EXPECTED_CHECKS = ['core-contract', 'box-count', 'bijection', 'render-backing', 'render-membership'];

const arenaRoot = (scene) => scene.children.find((c) => c.name === 'arena');
const mergedBufferStats = (scene) => {
  const root = arenaRoot(scene);
  if (!root) return { meshes: 0, vertices: 0, triangles: 0, materials: [] };
  let vertices = 0;
  let triangles = 0;
  const materials = [];
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.name.startsWith('arena:') && o.geometry?.getAttribute) {
      meshes.push(o);
      const pos = o.geometry.getAttribute('position');
      const idx = o.geometry.getIndex();
      const v = pos ? pos.count : 0;
      vertices += v;
      triangles += idx ? idx.count / 3 : v / 3;
      materials.push(o.name.replace('arena:', ''));
    }
  });
  return { meshes: meshes.length, vertices, triangles, materials: materials.sort() };
};

try {
  const canvas = document.getElementById('game') ?? document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(640, 400, false);
  const camera = new THREE.PerspectiveCamera(70, 640 / 400, 0.1, 200);
  const makeCtx = (scene) => ({ scene, camera, renderer });

  const def = buildRelayArena();
  const assertions = [];
  const add = (name, passed, actual, expected) =>
    assertions.push({ name, passed, actual, expected });

  // ── 1. Build + correspondence against real merged buffers ─────────────────
  const scene1 = new THREE.Scene();
  const world1 = buildStaticWorld(def);
  const arena1 = new ArenaLevel(def, world1, { containerDressing: false });
  arena1.init(makeCtx(scene1));

  const report1 = arena1.correspondence ?? out.__ARENA_CHECK__;
  const names1 = report1.results.map((r) => r.name);
  const allFive = EXPECTED_CHECKS.every((n) => {
    const c = report1.results.find((r) => r.name === n);
    return c && c.ok;
  });
  const buffers1 = mergedBufferStats(scene1);

  add('correspondence_all_five_green',
    report1.ok && allFive && EXPECTED_CHECKS.every((n) => names1.includes(n)),
    { ok: report1.ok, checks: report1.results.map((r) => ({ name: r.name, ok: r.ok })) },
    'all five correspondence checks pass against the real merged buffers');
  add('merged_buffers_non_empty',
    buffers1.meshes > 0 && buffers1.vertices > 0 && buffers1.triangles > 0,
    buffers1,
    'the arena mounted real, non-empty merged geometry (one mesh per material)');
  add('shot_hook_installed', typeof out.__SHOT__ === 'function',
    { shotHook: typeof out.__SHOT__ },
    'the level installed window.__SHOT__ for the evidence tool');
  add('static_world_published',
    !!out.__LEVEL_STATIC_WORLD__ && Array.isArray(world1.boxes) && world1.boxes.length > 0,
    { boxes: world1.boxes.length },
    'the shipping StaticWorld is published and non-empty');
  // The box-count check ties collidable solids to collision boxes; surface it.
  const boxCount = report1.results.find((r) => r.name === 'box-count');
  add('box_count_detail_present', !!boxCount && boxCount.ok,
    { detail: boxCount?.detail ?? null },
    'box-count correspondence detail present and green');

  // ── 2. Dispose → scene + globals cleaned, GPU handles released ─────────────
  renderer.render(scene1, camera);
  const geomAfterBuild = renderer.info.memory.geometries;
  arena1.dispose();
  renderer.render(scene1, camera);
  const geomAfterDispose = renderer.info.memory.geometries;

  add('dispose_removes_arena_root', arenaRoot(scene1) === undefined,
    { arenaRootPresent: arenaRoot(scene1) !== undefined, sceneChildren: scene1.children.length },
    'dispose removed the arena root group from the scene');
  add('dispose_cleans_globals',
    out.__SHOT__ === undefined && out.__ARENA_CHECK__ === undefined,
    { shotHook: typeof out.__SHOT__, arenaCheck: typeof out.__ARENA_CHECK__ },
    'dispose deleted the window.__SHOT__ and window.__ARENA_CHECK__ hooks');
  add('dispose_releases_geometry', geomAfterDispose < geomAfterBuild,
    { geomAfterBuild, geomAfterDispose },
    'GPU geometry handles dropped after dispose (merged buffers freed)');

  // ── 3. Rebuild on a fresh scene → correspondence green again ───────────────
  const scene2 = new THREE.Scene();
  const world2 = buildStaticWorld(def);
  const arena2 = new ArenaLevel(def, world2, { containerDressing: false });
  arena2.init(makeCtx(scene2));
  const report2 = arena2.correspondence ?? out.__ARENA_CHECK__;
  const buffers2 = mergedBufferStats(scene2);

  add('rebuild_correspondence_green',
    report2.ok && EXPECTED_CHECKS.every((n) => {
      const c = report2.results.find((r) => r.name === n);
      return c && c.ok;
    }),
    { ok: report2.ok, checks: report2.results.map((r) => ({ name: r.name, ok: r.ok })) },
    'a fresh build on a new scene passes correspondence again (no leaked state)');
  add('rebuild_matches_first_build',
    buffers2.meshes === buffers1.meshes && buffers2.vertices === buffers1.vertices,
    { first: buffers1, rebuilt: buffers2 },
    'the rebuilt merged geometry is identical to the first build (deterministic)');

  arena2.dispose();

  // ── 4. Integration footgun: default container dressing vs the safe factory ──
  // buildRelayArena() has NO `container` solids, but ArenaLevel defaults its
  // container dressing ON, and that path throws on an empty selection
  // (createContainerDressingLayer([]) → mergeGeometries([]) → TypeError). So a
  // caller who mounts the mission the obvious way — `new ArenaLevel(def, world)`
  // with DEFAULT options — crashes in init. Reproduce that (red), then prove
  // createRelayLevel() closes it (green). All under relay/**; the shared root
  // cause (ArenaLevel defaulting dressing on for a container-less def) is parent
  // integration work, not touched here.
  const sceneUnsafe = new THREE.Scene();
  const arenaUnsafe = new ArenaLevel(def, buildStaticWorld(def)); // DEFAULT options — the footgun
  let unsafeThrew = false;
  let unsafeError = null;
  try {
    arenaUnsafe.init(makeCtx(sceneUnsafe));
  } catch (e) {
    unsafeThrew = true;
    unsafeError = e instanceof Error ? e.message : String(e);
  }
  try { arenaUnsafe.dispose(); } catch { /* partial init — best-effort teardown */ }
  // The unsafe init sets some window globals before it throws and (never having
  // installed the shot hook) its dispose leaves them behind; clear them so the
  // footgun probe leaves no residue in the published report.
  for (const k of ['__ARENA_CHECK__', '__LEVEL_STATIC_WORLD__', '__ARENA_SPAWNS__', '__CONTACT_SHADOWS__', '__CONTAINER_DRESSING__']) {
    delete out[k];
  }

  add('unsafe_default_path_throws',
    unsafeThrew && !/correspondence/i.test(unsafeError ?? ''),
    { threw: unsafeThrew, error: unsafeError },
    'raw new ArenaLevel(def, world) with DEFAULT options throws building container dressing on the relay\'s empty container selection (the integration footgun) — and not from a correspondence failure');

  // The factory: containerDressing resolves to false via `?? false`, so the SAME
  // default-shaped mount is safe and builds no dressing layer.
  const sceneFactory = new THREE.Scene();
  const factoryLevel = createRelayLevel(); // no options
  let factoryThrew = false;
  let factoryError = null;
  try {
    factoryLevel.init(makeCtx(sceneFactory));
  } catch (e) {
    factoryThrew = true;
    factoryError = e instanceof Error ? e.message : String(e);
  }
  add('factory_default_path_survives',
    !factoryThrew
      && !!factoryLevel.correspondence?.ok
      && arenaRoot(sceneFactory) !== undefined
      && factoryLevel.containerDressing === undefined,
    {
      threw: factoryThrew, error: factoryError,
      correspondenceOk: factoryLevel.correspondence?.ok ?? null,
      mounted: arenaRoot(sceneFactory) !== undefined,
      dressingLayer: factoryLevel.containerDressing === undefined ? 'none' : 'built',
    },
    'createRelayLevel() builds + passes correspondence on the same default-shaped path that crashes raw ArenaLevel, and builds NO container-dressing layer');
  factoryLevel.dispose();

  // The `?? false` must resolve an EXPLICIT `undefined` off too (not just an
  // absent option), so the factory is safe even when a caller forwards options.
  const sceneFactoryUndef = new THREE.Scene();
  const factoryLevelUndef = createRelayLevel({ containerDressing: undefined });
  let factoryUndefThrew = false;
  let factoryUndefError = null;
  try {
    factoryLevelUndef.init(makeCtx(sceneFactoryUndef));
  } catch (e) {
    factoryUndefThrew = true;
    factoryUndefError = e instanceof Error ? e.message : String(e);
  }
  add('factory_explicit_undefined_resolves_off',
    !factoryUndefThrew
      && !!factoryLevelUndef.correspondence?.ok
      && factoryLevelUndef.containerDressing === undefined,
    {
      threw: factoryUndefThrew, error: factoryUndefError,
      correspondenceOk: factoryLevelUndef.correspondence?.ok ?? null,
      dressingLayer: factoryLevelUndef.containerDressing === undefined ? 'none' : 'built',
    },
    'createRelayLevel({ containerDressing: undefined }) still resolves to OFF via `?? false`, so the explicit-undefined path never throws either');
  factoryLevelUndef.dispose();

  renderer.dispose();

  const ok = assertions.every((a) => a.passed);
  out.__RELAY_INTEGRITY__ = {
    at: new Date().toISOString(),
    ok,
    renderer: 'real THREE.WebGLRenderer (headless WebGL2)',
    correspondenceChecks: report1.results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })),
    mergedBuffers: buffers1,
    lifecycle: { geomAfterBuild, geomAfterDispose },
    containerDressingFootgun: {
      unsafeDefaultPathThrew: unsafeThrew,
      unsafeError,
      factoryDefaultSafe: !factoryThrew,
      factoryExplicitUndefinedSafe: !factoryUndefThrew,
    },
    assertions,
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__RELAY_INTEGRITY_ERROR__ = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  out.__FRAME_READY__ = true;
}
