/**
 * Authored contact-grounding shadows for floor-standing cover.
 *
 * The problem this solves is not lighting, it is *reading*: the shipped VSM/IBL
 * pass darkens so little under the cover (a direct on/off framebuffer diff moved
 * 0.77 % of pixels, mean 0.154/255) that a crate reads as hovering a millimetre
 * above the floor. Ambient occlusion would fix it, but N8AO measured ~7–8 ms on
 * this machine and alone breaks the 16.7 ms budget (#1/#12), so it is off.
 *
 * Instead this authors the contact cue directly: one flat, soft dark mark on the
 * floor under each piece of *floor-standing* cover, sized to that solid's exact
 * footprint. It is a cheat, and an honest one — it is render-only, it never
 * enters collision, and it is derived from the SAME `Solid` min/max records that
 * produce the geometry and the collider, so it cannot drift from what the player
 * actually stands next to (the #8 failure mode this subsystem is built to refuse).
 *
 * Cost, by construction:
 *   - ONE draw call: a single `InstancedMesh`, one instance per selected solid.
 *   - ZERO generated textures: the soft rounded-rectangle penumbra is computed
 *     analytically in the fragment shader from a per-instance footprint, so the
 *     mark is footprint-aware (a long container gets a long mark, a drum a small
 *     square-ish one) with a uniform-width soft edge — never an oval sticker.
 *   - No per-frame allocation: every instance matrix and attribute is written
 *     once at build; `update()` does nothing.
 *
 * This file uses `three` (it builds GPU objects) but reads the world through the
 * pure `Solid` records, so selection and footprint are provable headlessly.
 */

import * as THREE from 'three';
import type { ArenaDefinition, Solid } from './arena.js';

/** The arena floor's top face is y=0; floor-standing solids rest their base here. */
const FLOOR_TOP_Y = 0;

/** A solid is "floor-standing" if its base sits within this of the floor top. */
const FLOOR_EPS = 1e-4;

/**
 * Ids (or `prefix-` families) that are level *shell / traversal* geometry, never
 * props a contact mark belongs under. Perimeter walls, the access stairs, the
 * overwatch deck and its parapets are architecture: grounding them would either
 * paint a mark up against a wall base or — for the stairs — drop a dark rug on a
 * surface the player walks across. Kept explicit and named so the exclusion is
 * auditable rather than a buried heuristic. (`deck`/`parapet-*` are already
 * excluded by the floor-standing test; listing them documents the intent and
 * keeps the rule robust if their base ever changes.)
 */
const ARCHITECTURE_ID_PREFIXES = ['wall', 'step', 'deck', 'parapet'] as const;

function isArchitecture(id: string): boolean {
  return ARCHITECTURE_ID_PREFIXES.some((p) => id === p || id.startsWith(`${p}-`));
}

export interface ContactEligibility {
  readonly id: string;
  readonly eligible: boolean;
  readonly reason: string;
}

/**
 * Deterministic, auditable eligibility for a single solid. A solid earns a
 * contact mark iff it is real cover (collidable — this drops the render-only
 * lamps, beacon and floor paint), it rests on the floor (this drops the floor
 * slab itself, every stacked upper solid, and the elevated deck/parapets), and
 * it is a prop rather than architecture (this drops the perimeter walls and the
 * stairs, which pass the floor-standing test but are not cover). The order of
 * the reasons below is the order of the tests, so the reason names the first
 * rule a solid failed.
 */
export function classifyGroundContact(solid: Solid): ContactEligibility {
  if (!solid.collide) {
    return { id: solid.id, eligible: false, reason: 'render-only dressing (collide=false)' };
  }
  if (Math.abs(solid.min[1] - FLOOR_TOP_Y) > FLOOR_EPS) {
    return {
      id: solid.id,
      eligible: false,
      reason: `not floor-standing (base y=${solid.min[1]} != ${FLOOR_TOP_Y})`,
    };
  }
  if (isArchitecture(solid.id)) {
    return { id: solid.id, eligible: false, reason: 'architecture (wall/stair/deck/parapet)' };
  }
  return { id: solid.id, eligible: true, reason: 'floor-standing cover' };
}

/** Every solid classified, in declaration order — the audit trail for the fixture. */
export function describeGroundContact(def: ArenaDefinition): ContactEligibility[] {
  return def.solids.map(classifyGroundContact);
}

/** The floor-standing cover that earns a contact mark, in declaration order. */
export function selectGroundContactSolids(def: ArenaDefinition): Solid[] {
  return def.solids.filter((s) => classifyGroundContact(s).eligible);
}

/**
 * Tuning for the mark. Deliberately conservative:
 *   - `penumbra` is the uniform soft-edge width in metres added around the exact
 *     footprint. Kept small (0.20 m) so a mark never bridges the gap to the next
 *     piece of cover; the nearest eligible pair (the mid-arena containers) clear
 *     each other with margin at this width.
 *   - `yOffset` lifts the mark a measured 6 mm above the floor top. That is the
 *     smallest lift that renders cleanly above the coplanar floor at 1080p
 *     grazing angles (paired with a polygon-offset depth bias), and it is far
 *     below anything the collider cares about — the mark carries no collision at
 *     all, so this number is purely a z-fighting margin.
 *   - `peak` is the maximum darkening alpha at the fully-occluded core. 0.42
 *     grounds the cover without punching a black hole in the floor.
 */
export interface ContactShadowOptions {
  readonly penumbra?: number;
  readonly yOffset?: number;
  readonly peak?: number;
}

export const CONTACT_SHADOW_DEFAULTS = {
  penumbra: 0.2,
  yOffset: 0.006,
  peak: 0.42,
} as const;

/** One placed mark — its footprint is derived, never a duplicated coordinate. */
export interface ContactInstance {
  readonly id: string;
  /** Footprint centre on the floor plane, from (min+max)/2. */
  readonly center: readonly [number, number];
  /** Exact footprint size from (max-min) on X and Z. */
  readonly footprint: readonly [number, number];
}

export interface ContactShadowLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly geometry: THREE.PlaneGeometry;
  readonly material: THREE.MeshBasicMaterial;
  readonly instances: readonly ContactInstance[];
  readonly penumbra: number;
  readonly yOffset: number;
  readonly peak: number;
  dispose(): void;
}

/**
 * Build the contact-shadow layer for a set of already-selected floor-standing
 * solids. The caller owns selection (`selectGroundContactSolids`) so the same
 * list can be audited without building GPU objects.
 *
 * The mark is a unit quad baked flat into the XZ plane, instanced once per
 * solid. Each instance is scaled to `footprint + 2·penumbra` and translated to
 * the footprint centre; a per-instance `aHalf`/`aFull` pair lets the fragment
 * shader recover world-space coordinates and paint a rounded-rectangle whose
 * core (fully dark) is exactly the footprint and whose soft edge is a uniform
 * `penumbra` metres wide — so the mark hugs the object's outline rather than
 * fading as a generic oval, at any aspect ratio, from ONE material.
 */
export function createContactShadowLayer(
  solids: readonly Solid[],
  options: ContactShadowOptions = {},
): ContactShadowLayer {
  const penumbra = options.penumbra ?? CONTACT_SHADOW_DEFAULTS.penumbra;
  const yOffset = options.yOffset ?? CONTACT_SHADOW_DEFAULTS.yOffset;
  const peak = options.peak ?? CONTACT_SHADOW_DEFAULTS.peak;

  // A 1×1 plane rotated flat: its normal points +Y and it lies in the XZ plane,
  // so an instance can never climb a vertical face — it is geometrically
  // horizontal. The rotation is baked so instance matrices carry only translate
  // + non-uniform scale.
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);

  const count = solids.length;
  const aHalf = new Float32Array(count * 2); // world half-footprint (fully-dark core)
  const aFull = new Float32Array(count * 2); // footprint + 2·penumbra (quad size)

  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 1,
    depthWrite: false, // a flat mark must not occlude anything
    depthTest: true, //   but must be hidden by cover standing in front of it
    polygonOffset: true, // bias toward the camera so it wins against the floor
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
    fog: false, // keep the darkening pure; the AgX post-grade handles the frame
  });
  // Stable cache key so this program is never deduped against a plain basic mat.
  material.customProgramCacheKey = () => 'arena-contact-shadow-v1';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPenumbra = { value: penumbra };
    shader.uniforms.uPeak = { value: peak };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec2 aHalf;\nattribute vec2 aFull;\nvarying vec2 vHalf;\nvarying vec2 vCoord;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvHalf = aHalf;\n\tvCoord = position.xz * aFull;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uPenumbra;\nuniform float uPeak;\nvarying vec2 vHalf;\nvarying vec2 vCoord;',
      )
      .replace(
        '#include <dithering_fragment>',
        [
          '\tvec2 q = abs(vCoord) - vHalf;',
          '\tfloat outside = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);',
          '\tfloat contact = 1.0 - smoothstep(0.0, uPenumbra, outside);',
          '\tfloat grain = fract(sin(dot(floor(vCoord * 6.0), vec2(12.9898, 78.233))) * 43758.5453);',
          '\tcontact *= 0.9 + 0.14 * grain;',
          '\tgl_FragColor.a *= clamp(contact, 0.0, 1.0) * uPeak;',
          '#include <dithering_fragment>',
        ].join('\n'),
      );
  };

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = 'arena:contact-shadows';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  // Draw after the opaque arena so the transparent mark blends over solid floor.
  mesh.renderOrder = 1;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const instances: ContactInstance[] = solids.map((solid, i) => {
    const w = solid.max[0] - solid.min[0];
    const d = solid.max[2] - solid.min[2];
    const cx = (solid.min[0] + solid.max[0]) / 2;
    const cz = (solid.min[2] + solid.max[2]) / 2;

    aHalf[i * 2] = w / 2;
    aHalf[i * 2 + 1] = d / 2;
    aFull[i * 2] = w + penumbra * 2;
    aFull[i * 2 + 1] = d + penumbra * 2;

    position.set(cx, yOffset, cz);
    scale.set(w + penumbra * 2, 1, d + penumbra * 2);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);

    return { id: solid.id, center: [cx, cz], footprint: [w, d] };
  });

  geometry.setAttribute('aHalf', new THREE.InstancedBufferAttribute(aHalf, 2));
  geometry.setAttribute('aFull', new THREE.InstancedBufferAttribute(aFull, 2));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();

  return {
    mesh,
    geometry,
    material,
    instances,
    penumbra,
    yOffset,
    peak,
    dispose(): void {
      mesh.parent?.remove(mesh);
      mesh.dispose(); // frees the per-instance GPU buffers
      geometry.dispose();
      material.dispose();
    },
  };
}
