/**
 * Contact-shadow fixture (issue #60).
 *
 * Correspondence proves render == collision; the deck-traversal fixture proves a
 * player can walk the geometry they agree on. This fixture proves the third
 * thing #60 adds — the authored floor contact-grounding layer — is what it
 * claims: sourced from the real `Solid` records, one draw, no generated texture,
 * render-only (adds no collider and cannot make the 5/5 proof misread geometry),
 * lifecycle-clean, and a genuine visual change under cover rather than an oval
 * sticker. Every number is derived from the shipped modules, not re-asserted.
 *
 * It runs in the browser (Vite transpiles the imported `.ts`) so the InstancedMesh,
 * the procedural penumbra shader and disposal are exercised on the REAL GPU path,
 * then publishes the report on `window.__CONTACT_SHADOWS_FIXTURE__` for the
 * playwright runner to archive. A `.mjs`, like the deck-traversal fixture, so it
 * stays out of `tsc` while binding the real runtime.
 */

import * as THREE from 'three';
import { buildArena } from '../arena.js';
import { buildStaticWorld, collidableSolids } from '../staticWorld.js';
import { mergeSolidsByMaterial, cornerKey, solidCornerKeys } from '../geometry.js';
import { checkCorrespondence } from '../correspondence.js';
import { ArenaLevel } from '../ArenaLevel.js';
import {
  selectGroundContactSolids,
  describeGroundContact,
  classifyGroundContact,
  createContactShadowLayer,
  CONTACT_SHADOW_DEFAULTS,
} from '../contactShadows.js';

const out = window;
const round = (v, d = 6) => {
  const s = 10 ** d;
  return Math.round(v * s) / s;
};

// The floor-standing cover this layer is meant to ground, and the ineligible
// solids the selector must reject. Hard-coded here on purpose: if a layout
// change silently adds or drops a mark, this list disagrees and the fixture
// goes red rather than following the implementation.
const EXPECTED_SELECTED = [
  'cont-a', 'cont-c', 'jersey-w1', 'jersey-w2', 'crate-w1',
  'crate-w2', 'dock-obj', 'jersey-n1', 'pallet-n', 'drum-n1',
];
const NEGATIVE_CONTROL = ['floor', 'wall-n-west', 'step-0', 'cont-b', 'beacon'];

try {
  const def = buildArena();
  const world = buildStaticWorld(def);
  const groups = mergeSolidsByMaterial(def.solids);
  const collidable = collidableSolids(def);
  const collidableIds = new Set(collidable.map((s) => s.id));

  const selected = selectGroundContactSolids(def);
  const selectedIds = selected.map((s) => s.id);
  const layer = createContactShadowLayer(selected);

  const assertions = [];
  const add = (name, passed, actual, expected) => assertions.push({ name, passed, actual, expected });

  // ── 1. Selection is exactly the authored floor-standing cover ─────────────
  const selMatches = selectedIds.length === EXPECTED_SELECTED.length
    && EXPECTED_SELECTED.every((id) => selectedIds.includes(id));
  add('selection_matches_authored', selMatches,
    { selected: selectedIds }, { expected: EXPECTED_SELECTED });

  // ── 2. Every selected solid really is floor-standing collidable cover ─────
  const notGrounded = selected.filter((s) => !(s.collide && Math.abs(s.min[1]) <= 1e-4));
  add('selected_are_floor_standing', notGrounded.length === 0,
    { offenders: notGrounded.map((s) => ({ id: s.id, collide: s.collide, minY: s.min[1] })) },
    'each selected solid collides and rests its base on the floor (min.y≈0)');

  // ── 3. Footprint is derived exactly from Solid min/max — no duplicate coords ─
  const footprintErrors = [];
  for (const inst of layer.instances) {
    const s = def.solids.find((q) => q.id === inst.id);
    if (!s) { footprintErrors.push(`${inst.id}: no source solid`); continue; }
    const cx = (s.min[0] + s.max[0]) / 2;
    const cz = (s.min[2] + s.max[2]) / 2;
    const w = s.max[0] - s.min[0];
    const d = s.max[2] - s.min[2];
    if (inst.center[0] !== cx || inst.center[1] !== cz
      || inst.footprint[0] !== w || inst.footprint[1] !== d) {
      footprintErrors.push(`${inst.id}: instance ${JSON.stringify(inst)} != solid-derived `
        + `center(${cx},${cz}) footprint(${w},${d})`);
    }
  }
  add('footprint_exact_from_solid', footprintErrors.length === 0,
    { errors: footprintErrors, sample: layer.instances[0] },
    'every instance center/footprint equals (min+max)/2 and (max-min) of its source Solid');

  // ── 4. Marks are horizontal and lifted a measured tiny offset ─────────────
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const identityQuat = new THREE.Quaternion();
  let maxTilt = 0;
  let offsetOk = true;
  for (let i = 0; i < layer.instances.length; i++) {
    layer.mesh.getMatrixAt(i, m);
    m.decompose(pos, quat, scl);
    if (Math.abs(pos.y - layer.yOffset) > 1e-6) offsetOk = false;
    maxTilt = Math.max(maxTilt, quat.angleTo(identityQuat));
  }
  // The baked plane normal must point +Y (the mark lies flat, cannot climb a face).
  const nrm = layer.geometry.getAttribute('normal');
  const n0 = new THREE.Vector3(nrm.getX(0), nrm.getY(0), nrm.getZ(0));
  const horizontal = Math.abs(n0.x) < 1e-6 && Math.abs(n0.y - 1) < 1e-6 && Math.abs(n0.z) < 1e-6;
  add('marks_horizontal', horizontal && maxTilt < 1e-6,
    { normal: n0.toArray().map((v) => round(v)), maxInstanceTiltRad: round(maxTilt, 8) },
    'plane normal is +Y and no instance is tilted — the mark cannot climb a vertical face');
  add('y_offset_measured', offsetOk && layer.yOffset === CONTACT_SHADOW_DEFAULTS.yOffset
    && layer.yOffset > 0 && layer.yOffset < 0.02,
    { yOffset: layer.yOffset }, `a measured ${CONTACT_SHADOW_DEFAULTS.yOffset} m lift, equal for every instance`);

  // ── 5. Render-only: adds no collider, cannot be misread as collidable ─────
  const worldAfter = buildStaticWorld(def);
  const instancesSubsetOfColliders = layer.instances.every((c) => collidableIds.has(c.id));
  add('adds_no_collider', worldAfter.boxes.length === collidable.length && instancesSubsetOfColliders,
    { boxes: worldAfter.boxes.length, collidable: collidable.length, instancesSubsetOfColliders },
    'the layer contributes zero StaticBoxes and every mark sits under a real collider');

  // The mark's own vertices must not coincide with any collider corner, or a
  // future render-backing check could mistake the shadow for the geometry.
  const colliderCornerKeys = new Set();
  for (const s of collidable) for (const k of solidCornerKeys(s)) colliderCornerKeys.add(k);
  const markKeys = new Set();
  const quadLocal = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
  for (const inst of layer.instances) {
    const [cx, cz] = inst.center;
    const [w, d] = inst.footprint;
    const fw = w + layer.penumbra * 2;
    const fd = d + layer.penumbra * 2;
    for (const [lx, lz] of quadLocal) {
      markKeys.add(cornerKey(cx + lx * fw, layer.yOffset, cz + lz * fd));
    }
  }
  const collision = [...markKeys].filter((k) => colliderCornerKeys.has(k));
  add('marks_not_mistaken_for_geometry', collision.length === 0,
    { sharedCornerKeys: collision.length },
    'no contact-mark vertex lands on a collider corner (render-backing cannot misclassify it)');

  // ── 6. Correspondence still 5/5 with the layer composed ───────────────────
  const report = checkCorrespondence(def, world, groups);
  add('correspondence_still_5_of_5', report.ok && report.results.length === 5,
    { ok: report.ok, checks: report.results.map((r) => `${r.name}:${r.ok ? 'PASS' : 'FAIL'}` ) },
    'all five correspondence checks pass with the contact layer present');

  // ── 7. Negative control: ineligible floor / wall / stair are rejected ─────
  const negatives = NEGATIVE_CONTROL.map((id) => {
    const s = def.solids.find((q) => q.id === id);
    const c = classifyGroundContact(s);
    return { id, eligible: c.eligible, reason: c.reason, selected: selectedIds.includes(id) };
  });
  const negOk = negatives.every((n) => !n.eligible && !n.selected);
  add('negative_control_rejected', negOk,
    { negatives },
    'floor, a perimeter wall, a stair tread, a stacked upper solid and a dressing solid are all rejected');

  layer.dispose();

  // ── 8. Lifecycle: repeatable build + clean dispose ────────────────────────
  const lifecycle = [];
  for (let pass = 0; pass < 2; pass++) {
    const l = createContactShadowLayer(selected);
    const holder = new THREE.Group();
    holder.add(l.mesh);
    let geomDisposed = false;
    let matDisposed = false;
    l.geometry.addEventListener('dispose', () => { geomDisposed = true; });
    l.material.addEventListener('dispose', () => { matDisposed = true; });
    l.dispose();
    lifecycle.push({
      pass,
      removedFromParent: l.mesh.parent === null,
      geometryDisposed: geomDisposed,
      materialDisposed: matDisposed,
    });
  }
  const lifecycleOk = lifecycle.every((p) => p.removedFromParent && p.geometryDisposed && p.materialDisposed);
  add('lifecycle_repeatable_clean', lifecycleOk, { lifecycle },
    'build → dispose is repeatable; dispose removes the mesh and frees geometry + material');

  // ── 9. Resource delta: one extra draw, zero generated textures ────────────
  // Two fresh renderers so the numbers are apples-to-apples: the identical arena
  // with and without the layer.
  const W = 1280;
  const H = 720;
  const makeArena = (contactShadows) => {
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
    const arena = new ArenaLevel(def, world, { contactShadows });
    arena.init(ctx);
    const shot = def.shots.find((s) => s.name === 'grounding');
    camera.position.set(...shot.position);
    camera.lookAt(new THREE.Vector3(...shot.lookAt));
    return { renderer, scene, camera, arena };
  };

  const off = makeArena(false);
  off.renderer.render(off.scene, off.camera);
  const drawsOff = off.renderer.info.render.calls;
  const texOff = off.renderer.info.memory.textures;

  const on = makeArena(true);
  on.renderer.render(on.scene, on.camera);
  const drawsOn = on.renderer.info.render.calls;
  const texOn = on.renderer.info.memory.textures;

  const contactMat = on.arena.contactShadows.material;
  const textureSlots = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'lightMap', 'emissiveMap', 'specularMap', 'envMap'];
  const generatedTextures = textureSlots.filter((k) => contactMat[k]).length;

  add('one_additional_draw', drawsOn - drawsOff === 1,
    { drawsOff, drawsOn, delta: drawsOn - drawsOff }, 'exactly one extra draw call (the InstancedMesh)');
  add('zero_generated_textures', texOn - texOff === 0 && generatedTextures === 0,
    { texturesOff: texOff, texturesOn: texOn, delta: texOn - texOff, materialTextureMaps: generatedTextures },
    'the procedural shader material allocates no texture (≤ the one-texture budget)');

  // ── 10. On/off pixel diff — a real, localized visual change ────────────────
  const gl = on.renderer.getContext();
  const readFrame = () => {
    on.renderer.render(on.scene, on.camera);
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  on.arena.contactShadows.mesh.visible = true;
  const frameOn = readFrame();
  on.arena.contactShadows.mesh.visible = false;
  const frameOff = readFrame();

  let changed = 0;
  let sumAll = 0;
  let sumChanged = 0;
  let maxDelta = 0;
  const THRESH = 2;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const dr = Math.abs(frameOn[o] - frameOff[o]);
    const dg = Math.abs(frameOn[o + 1] - frameOff[o + 1]);
    const db = Math.abs(frameOn[o + 2] - frameOff[o + 2]);
    const dmax = Math.max(dr, dg, db);
    sumAll += dmax;
    if (dmax > maxDelta) maxDelta = dmax;
    if (dmax > THRESH) { changed += 1; sumChanged += dmax; }
  }
  const total = W * H;
  const diff = {
    viewport: `${W}x${H}`,
    changedPixelsPct: round((changed / total) * 100, 4),
    meanDeltaAll: round(sumAll / total, 4),
    meanDeltaChanged: round(changed ? sumChanged / changed : 0, 4),
    maxDelta,
    baselineVsm: { changedPixelsPct: 0.7704, meanDelta: 0.154, note: 'direct on/off VSM diff from #60 situation' },
  };
  // The layer must visibly ground the cover (non-zero change) but stay localized
  // under it (not a full-frame wash), and darken harder where it lands than the
  // negligible VSM baseline did across the frame.
  add('pixel_diff_meaningful_and_local',
    diff.changedPixelsPct > 0.2 && diff.changedPixelsPct < 60 && diff.meanDeltaChanged > 1.0,
    diff, 'contact layer changes a non-zero, sub-majority region and darkens it well above the VSM baseline');

  off.arena.dispose();
  off.renderer.dispose();
  on.arena.dispose();
  on.renderer.dispose();

  const ok = assertions.every((a) => a.passed);
  out.__CONTACT_SHADOWS_FIXTURE__ = {
    at: new Date().toISOString(),
    ok,
    source: 'buildArena() → selectGroundContactSolids + createContactShadowLayer (shipped src/level)',
    defaults: CONTACT_SHADOW_DEFAULTS,
    selection: {
      count: selected.length,
      ids: selectedIds,
      instances: layer.instances.map((c) => ({ id: c.id, center: c.center.map((v) => round(v)), footprint: c.footprint.map((v) => round(v)) })),
    },
    eligibilityAudit: describeGroundContact(def),
    resource: {
      additionalDrawCalls: drawsOn - drawsOff,
      generatedTextures: texOn - texOff,
      drawCallsOff: drawsOff,
      drawCallsOn: drawsOn,
      texturesOff: texOff,
      texturesOn: texOn,
    },
    pixelDiff: diff,
    lifecycle,
    correspondence: report.results.map((r) => ({ name: r.name, ok: r.ok })),
    assertions,
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__CONTACT_SHADOWS_FIXTURE_ERROR__ = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  out.__FRAME_READY__ = true;
}
