/**
 * Container-art fixture (issue #67).
 *
 * Correspondence proves render == collision; the contact-shadow fixture proves
 * the #66 grounding layer is honest. This fixture proves the third thing #67
 * adds — the procedural container finishing — is what it claims:
 *
 *   - the corrugation is now a REAL normal profile derived from the SAME rib
 *     function as the albedo (so it self-shades with light), not the old generic
 *     metal bump;
 *   - all three containers carry bounds-derived ironwork (corner castings, posts,
 *     top/bottom rails, an inset end-door with locking bars/hinges/handles) whose
 *     orientation (long-X vs long-Z, door end) is INFERRED from each `Solid`
 *     bounds, never hand-typed;
 *   - it is render-only: it adds no collider and leaves the 5/5 correspondence
 *     intact;
 *   - it stays inside budget: ONE merged ironwork mesh (at most two GPU draws
 *     under the RenderSystem opaque depth-prepass), ONE extra generated texture
 *     (the rib normal), under an enforced triangle ceiling, no per-frame alloc;
 *   - lifecycle is repeatable and disposes cleanly;
 *   - a non-container solid (floor / wall / stair / wood crate / steel drum) is
 *     rejected by the selector.
 *
 * It runs in the browser (Vite transpiles the imported `.ts`) so the merged
 * geometry, the real material/texture path and disposal are exercised on the GPU,
 * then publishes the report on `window.__CONTAINER_ART_FIXTURE__` for the
 * playwright runner to archive. A `.mjs`, like the other fixtures, so it stays
 * out of `tsc` while binding the real runtime.
 */

import * as THREE from 'three';
import { buildArena } from '../arena.js';
import { buildStaticWorld, collidableSolids } from '../staticWorld.js';
import { mergeSolidsByMaterial, cornerKey, solidCornerKeys } from '../geometry.js';
import { checkCorrespondence } from '../correspondence.js';
import { ArenaLevel } from '../ArenaLevel.js';
import { createArenaMaterials, CONTAINER_RIB_FREQUENCY, containerRibHeight } from '../materials.js';
import {
  selectContainerSolids,
  describeContainerDressing,
  classifyContainerDressing,
  describeContainerAssembly,
  describeContainerAssemblies,
  createContainerDressingLayer,
  MAX_DRESSING_TRIANGLES,
  MAX_DRESSING_PROTRUSION,
} from '../containerDressing.js';

const out = window;
const round = (v, d = 6) => {
  const s = 10 ** d;
  return Math.round(v * s) / s;
};

// The containers that must be dressed, and their bounds-derived orientation.
// Hard-coded here on purpose: if a layout change silently re-orients a box or
// adds/drops a container, this table disagrees and the fixture goes red.
const EXPECTED = {
  'cont-a': { longAxis: 'x', doorEnd: 1.225 },
  'cont-b': { longAxis: 'x', doorEnd: 1.625 },
  'cont-c': { longAxis: 'z', doorEnd: -4.575 },
};
const EXPECTED_IDS = Object.keys(EXPECTED);
// Ineligible solids the selector must reject: floor, a perimeter wall, a stair
// tread, a wood crate and a steel drum — none are containers.
const NEGATIVE_CONTROL = ['floor', 'wall-n-west', 'step-0', 'crate-w1', 'drum-n1'];

try {
  const def = buildArena();
  const world = buildStaticWorld(def);
  const groups = mergeSolidsByMaterial(def.solids);
  const collidable = collidableSolids(def);

  const selected = selectContainerSolids(def);
  const selectedIds = selected.map((s) => s.id);
  const assemblies = describeContainerAssemblies(def);
  const layer = createContainerDressingLayer(selected);

  const assertions = [];
  const add = (name, passed, actual, expected) => assertions.push({ name, passed, actual, expected });

  // ── 1. Selection is exactly the three containers ──────────────────────────
  const selMatches = selectedIds.length === EXPECTED_IDS.length
    && EXPECTED_IDS.every((id) => selectedIds.includes(id));
  add('selection_matches_containers', selMatches,
    { selected: selectedIds }, { expected: EXPECTED_IDS });

  // ── 2. Selection is by the real `material` field, not a name heuristic ─────
  const byMaterial = selected.every((s) => s.material === 'container');
  add('selected_by_solid_material', byMaterial,
    { materials: selected.map((s) => ({ id: s.id, material: s.material })) },
    'every selected solid carries material="container" (a real Solid field)');

  // ── 3. Orientation + door end inferred from each Solid's bounds ───────────
  const orientationErrors = [];
  for (const a of assemblies) {
    const exp = EXPECTED[a.id];
    const sx = a.max[0] - a.min[0];
    const sz = a.max[2] - a.min[2];
    const derivedLong = sx >= sz ? 'x' : 'z';
    if (a.longAxis !== derivedLong || a.longAxis !== exp.longAxis) {
      orientationErrors.push(`${a.id}: longAxis ${a.longAxis} != derived ${derivedLong}/expected ${exp.longAxis}`);
    }
    const maxLong = a.longAxis === 'x' ? a.max[0] : a.max[2];
    if (Math.abs(a.doorEnd - maxLong) > 1e-9 || Math.abs(a.doorEnd - exp.doorEnd) > 1e-6) {
      orientationErrors.push(`${a.id}: doorEnd ${a.doorEnd} != max-long ${maxLong}/expected ${exp.doorEnd}`);
    }
  }
  add('orientation_from_bounds', orientationErrors.length === 0,
    { errors: orientationErrors, assemblies: assemblies.map((a) => ({ id: a.id, longAxis: a.longAxis, doorEnd: round(a.doorEnd) })) },
    'each assembly long axis is the larger footprint span and the door faces the max end');

  // ── 4. Bounds equal the source Solid exactly — no duplicated coordinates ──
  const boundsErrors = [];
  for (const a of assemblies) {
    const s = def.solids.find((q) => q.id === a.id);
    if (!s) { boundsErrors.push(`${a.id}: no source solid`); continue; }
    for (let i = 0; i < 3; i++) {
      if (a.min[i] !== s.min[i] || a.max[i] !== s.max[i]) {
        boundsErrors.push(`${a.id}: bounds ${JSON.stringify([a.min, a.max])} != solid ${JSON.stringify([s.min, s.max])}`);
      }
    }
  }
  add('bounds_match_source_solid', boundsErrors.length === 0,
    { errors: boundsErrors },
    'every assembly min/max is the source Solid min/max (footprint derived, not re-typed)');

  // ── 5. Every fitting is centimetre-scale and never leaves the body vertically ─
  let maxHoriz = 0;
  let maxVert = 0;
  let degenerate = 0;
  for (const a of assemblies) {
    const [x0, y0, z0] = a.min;
    const [x1, y1, z1] = a.max;
    for (const p of a.parts) {
      if (p.max[0] <= p.min[0] || p.max[1] <= p.min[1] || p.max[2] <= p.min[2]) degenerate += 1;
      maxHoriz = Math.max(maxHoriz, x0 - p.min[0], p.max[0] - x1, z0 - p.min[2], p.max[2] - z1);
      maxVert = Math.max(maxVert, y0 - p.min[1], p.max[1] - y1);
    }
  }
  add('fittings_centimetre_scale', maxHoriz <= MAX_DRESSING_PROTRUSION && maxVert <= 1e-9 && degenerate === 0,
    { maxHorizontalProtrusion: round(maxHoriz), maxVerticalProtrusion: round(maxVert, 9), ceiling: MAX_DRESSING_PROTRUSION, degenerate },
    `no fitting protrudes more than ${MAX_DRESSING_PROTRUSION} m horizontally, none pokes above the top or below the base`);

  // ── 6. Triangle ceiling is real and respected ─────────────────────────────
  add('triangle_ceiling_respected', layer.triangleCount > 0 && layer.triangleCount <= MAX_DRESSING_TRIANGLES,
    { triangleCount: layer.triangleCount, ceiling: MAX_DRESSING_TRIANGLES },
    `merged dressing is within the ${MAX_DRESSING_TRIANGLES}-triangle ceiling`);

  // ── 7. Rib normal map is derived from the shared corrugation function ─────
  // Build the real container material and read back the normal map's slope: a
  // horizontal scanline of the red channel (tangent-space nx) must oscillate at
  // the rib frequency, proving the corrugation drives the lighting normal rather
  // than a generic noise bump. Also confirm the shared height function is what
  // the albedo used, and that the toggle reverts to the pre-#67 bump.
  const W = 1280;
  const H = 720;
  const probe = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false });
  probe.setSize(W, H, false);
  const matsOn = createArenaMaterials(probe, { containerRibNormal: true });
  const matsOff = createArenaMaterials(probe, { containerRibNormal: false });
  const containerOn = matsOn.byKey.container;
  const containerOff = matsOff.byKey.container;

  const normalTex = containerOn.normalMap;
  let ribCrossings = 0;
  let ribSwing = 0;
  if (normalTex && normalTex.image) {
    const src = normalTex.image;
    const rc = document.createElement('canvas');
    rc.width = src.width; rc.height = src.height;
    const rctx = rc.getContext('2d');
    rctx.drawImage(src, 0, 0);
    const row = rctx.getImageData(0, src.height >> 1, src.width, 1).data;
    let prevSign = 0;
    let minR = 255; let maxR = 0;
    for (let x = 0; x < src.width; x++) {
      const r = row[x * 4];
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      const s = Math.sign(r - 128);
      if (s !== 0 && s !== prevSign && prevSign !== 0) ribCrossings += 1;
      if (s !== 0) prevSign = s;
    }
    ribSwing = maxR - minR;
  }
  // sin(x·f) over a 256px tile completes 256·f/2π periods → ~8.15 here, i.e. ~16
  // sign changes of the derivative-based nx. Weathering noise widens the band.
  const expectedPeriods = (256 * CONTAINER_RIB_FREQUENCY) / (2 * Math.PI);
  const ribOk = normalTex != null
    && containerOn.bumpMap == null
    && containerOn.normalScale.x > 0
    && ribCrossings >= 10 && ribCrossings <= 24
    && ribSwing > 20;
  add('rib_normal_from_shared_function', ribOk,
    {
      hasNormalMap: normalTex != null,
      bumpMapCleared: containerOn.bumpMap == null,
      normalScaleX: round(containerOn.normalScale.x),
      ribFrequency: CONTAINER_RIB_FREQUENCY,
      expectedPeriods: round(expectedPeriods, 3),
      ribScanlineSignChanges: ribCrossings,
      ribScanlineSwing: ribSwing,
      sharedHeightSample: round(containerRibHeight(3)),
    },
    'container normalMap encodes the rib profile (nx oscillates at the rib frequency); bumpMap cleared');

  // ── 8. The off toggle reproduces the pre-#67 generic bump material ────────
  const offRevert = containerOff.normalMap == null && containerOff.bumpMap != null
    && matsOn.textures.length - matsOff.textures.length === 1;
  add('off_toggle_is_pre67_baseline', offRevert,
    {
      offNormalMap: containerOff.normalMap == null ? null : 'set',
      offBumpMap: containerOff.bumpMap == null ? null : 'set',
      textureDelta: matsOn.textures.length - matsOff.textures.length,
    },
    '?dressing=0 restores the albedo-only rib + generic metal bump and one fewer texture');

  matsOn.dispose();
  matsOff.dispose();
  probe.dispose();

  // ── 9. Render-only: adds no collider, dressing corners are not geometry ────
  const worldAfter = buildStaticWorld(def);
  add('adds_no_collider', worldAfter.boxes.length === collidable.length,
    { boxes: worldAfter.boxes.length, collidable: collidable.length },
    'the dressing contributes zero StaticBoxes — the collider stays the container body box');

  const colliderCornerKeys = new Set();
  for (const s of collidable) for (const k of solidCornerKeys(s)) colliderCornerKeys.add(k);
  let dressingOnCollider = 0;
  for (const a of assemblies) {
    for (const p of a.parts) {
      for (const x of [p.min[0], p.max[0]]) {
        for (const y of [p.min[1], p.max[1]]) {
          for (const z of [p.min[2], p.max[2]]) {
            if (colliderCornerKeys.has(cornerKey(x, y, z))) dressingOnCollider += 1;
          }
        }
      }
    }
  }
  add('dressing_not_mistaken_for_geometry', dressingOnCollider === 0,
    { sharedCornerKeys: dressingOnCollider },
    'no dressing vertex lands on a collider corner (render-backing cannot misclassify it)');

  // ── 10. Correspondence still 5/5 with the dressing composed ───────────────
  const report = checkCorrespondence(def, world, groups);
  add('correspondence_still_5_of_5', report.ok && report.results.length === 5,
    { ok: report.ok, checks: report.results.map((r) => `${r.name}:${r.ok ? 'PASS' : 'FAIL'}`) },
    'all five correspondence checks pass with the dressing present');

  // ── 11. Negative control: non-container solids rejected ───────────────────
  const negatives = NEGATIVE_CONTROL.map((id) => {
    const s = def.solids.find((q) => q.id === id);
    const c = classifyContainerDressing(s);
    return { id, material: s.material, eligible: c.eligible, reason: c.reason, selected: selectedIds.includes(id) };
  });
  const negOk = negatives.every((n) => !n.eligible && !n.selected);
  add('negative_control_rejected', negOk,
    { negatives },
    'floor, a perimeter wall, a stair tread, a wood crate and a steel drum are all rejected');

  // ── 12. Resource delta measured on the real GPU: +2 draws, +1 texture ─────
  const makeArena = (containerDressing) => {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, W / H, 0.1, 200);
    const ctx = {
      scene, camera, renderer, time: 0,
      input: { move: { x: 0, y: 0 }, look: { x: 0, y: 0 }, jump: false, crouch: false, sprint: false, fire: false, aim: false, reload: false, pressed: () => false },
      bus: { on() {}, off() {}, emit() {} }, quality: 'high', get: () => undefined,
    };
    const arena = new ArenaLevel(def, world, { containerDressing });
    arena.init(ctx);
    // Frame the whole container cluster so both dressing meshes are in view, and
    // disable their frustum cull so the delta is a clean count of the two draws.
    camera.position.set(0, 11.5, 7.5);
    camera.lookAt(new THREE.Vector3(0, 1.2, -9));
    if (arena.containerDressing) for (const mesh of arena.containerDressing.meshes) mesh.frustumCulled = false;
    return { renderer, scene, camera, arena };
  };

  const offA = makeArena(false);
  offA.renderer.render(offA.scene, offA.camera);
  const drawsOff = offA.renderer.info.render.calls;
  const texOff = offA.renderer.info.memory.textures;

  const onA = makeArena(true);
  onA.renderer.render(onA.scene, onA.camera);
  const drawsOn = onA.renderer.info.render.calls;
  const texOn = onA.renderer.info.memory.textures;

  const drawDelta = drawsOn - drawsOff;
  const texDelta = texOn - texOff;
  const dressingDraws = onA.arena.containerDressing.meshes.length;
  add('merged_draw_within_budget', dressingDraws === 1 && drawDelta === dressingDraws && drawDelta <= 2,
    { drawsOff, drawsOn, delta: drawDelta, dressingMeshes: dressingDraws,
      shippingPrepassNote: 'this one opaque mesh renders as 2 GPU draws under the RenderSystem depth-prepass — within the ≤2 budget' },
    'the ironwork is ONE merged material mesh (≤2 GPU draws even with the opaque depth-prepass)');
  add('one_additional_texture', texDelta === 1,
    { texturesOff: texOff, texturesOn: texOn, delta: texDelta },
    'exactly one extra generated texture (the rib normal map); dressing steel is mapless');

  // Correspondence inside the fully-composed level (dressing on) is still green.
  add('composed_level_correspondence_ok', onA.arena.correspondence?.ok === true,
    { ok: onA.arena.correspondence?.ok },
    'ArenaLevel.init runs the 5/5 proof green with the dressing built and added');

  offA.arena.dispose();
  offA.renderer.dispose();
  onA.arena.dispose();
  onA.renderer.dispose();

  layer.dispose();

  // ── 13. Lifecycle: repeatable build + clean dispose ───────────────────────
  const lifecycle = [];
  for (let pass = 0; pass < 2; pass++) {
    const l = createContainerDressingLayer(selected);
    const holder = new THREE.Group();
    for (const mesh of l.meshes) holder.add(mesh);
    const disposed = { geometry: false, material: false };
    l.mesh.geometry.addEventListener('dispose', () => { disposed.geometry = true; });
    l.mesh.material.addEventListener('dispose', () => { disposed.material = true; });
    l.dispose();
    lifecycle.push({
      pass,
      removedFromParent: l.meshes.every((m) => m.parent === null),
      ...disposed,
    });
  }
  const lifecycleOk = lifecycle.every((p) => p.removedFromParent && p.geometry && p.material);
  add('lifecycle_repeatable_clean', lifecycleOk, { lifecycle },
    'build → dispose is repeatable; dispose removes the mesh and frees geometry + material');

  const ok = assertions.every((a) => a.passed);
  out.__CONTAINER_ART_FIXTURE__ = {
    at: new Date().toISOString(),
    ok,
    source: 'buildArena() → selectContainerSolids + describeContainerAssembly + createContainerDressingLayer (shipped src/level)',
    budget: { maxTriangles: MAX_DRESSING_TRIANGLES, maxProtrusion: MAX_DRESSING_PROTRUSION, ribFrequency: CONTAINER_RIB_FREQUENCY },
    selection: {
      count: selected.length,
      ids: selectedIds,
      assemblies: assemblies.map((a) => ({
        id: a.id,
        longAxis: a.longAxis,
        shortAxis: a.shortAxis,
        doorEnd: round(a.doorEnd),
        min: a.min.map((v) => round(v)),
        max: a.max.map((v) => round(v)),
        partCount: a.parts.length,
        parts: a.parts.reduce((acc, p) => { acc[p.kind] = (acc[p.kind] ?? 0) + 1; return acc; }, {}),
      })),
    },
    eligibilityAudit: describeContainerDressing(def),
    geometry: { triangleCount: layer.triangleCount, mesh: 'arena:container-dressing', mergedMeshes: layer.meshes.length },
    resource: {
      additionalDrawCalls: drawDelta,
      additionalTextures: texDelta,
      drawCallsOff: drawsOff, drawCallsOn: drawsOn,
      texturesOff: texOff, texturesOn: texOn,
    },
    ribNormal: { scanlineSignChanges: ribCrossings, scanlineSwing: ribSwing, expectedPeriods: round(expectedPeriods, 3) },
    correspondence: report.results.map((r) => ({ name: r.name, ok: r.ok })),
    lifecycle,
    assertions,
  };
} catch (err) {
  out.__CONTAINER_ART_FIXTURE_ERROR__ = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
}
