/**
 * Turns arena solids into `three` geometry — the SAME geometry the correspondence
 * proof inspects and the renderer draws. Boxes are grouped by material and merged
 * so a ~45-solid arena costs a handful of draw calls rather than one per box.
 *
 * Runs headless: it uses only `three`'s geometry classes (no renderer, no DOM),
 * so `correspondence.ts` can rebuild and verify the exact merged buffers in Node.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKey, Solid } from './arena.js';

/** Texture tiles per metre — keeps procedural maps at a consistent world scale. */
const UV_DENSITY = 0.7;

/** Quantise a world coordinate to a 1 mm grid key for exact corner matching. */
export function cornerKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1000)}|${Math.round(y * 1000)}|${Math.round(z * 1000)}`;
}

/** The eight corners of a solid, as quantised keys. */
export function solidCornerKeys(solid: Solid): string[] {
  const keys: string[] = [];
  for (const x of [solid.min[0], solid.max[0]]) {
    for (const y of [solid.min[1], solid.max[1]]) {
      for (const z of [solid.min[2], solid.max[2]]) {
        keys.push(cornerKey(x, y, z));
      }
    }
  }
  return keys;
}

/** Every distinct vertex position in a merged geometry, as quantised keys. */
export function geometryCornerKeys(geometry: THREE.BufferGeometry): Set<string> {
  const pos = geometry.getAttribute('position');
  const keys = new Set<string>();
  for (let i = 0; i < pos.count; i++) {
    keys.add(cornerKey(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return keys;
}

/**
 * One box, sized and positioned in world space, with UVs scaled so textures
 * tile at world scale rather than stretching to fit each face.
 */
function boxGeometry(solid: Solid): THREE.BufferGeometry {
  const w = solid.max[0] - solid.min[0];
  const h = solid.max[1] - solid.min[1];
  const d = solid.max[2] - solid.min[2];
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(
    (solid.min[0] + solid.max[0]) / 2,
    (solid.min[1] + solid.max[1]) / 2,
    (solid.min[2] + solid.max[2]) / 2,
  );

  // Scale UVs per face by that face's world dimensions. BoxGeometry emits faces
  // in the order +x,-x,+y,-y,+z,-z, four verts each.
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const faceDims: Array<[number, number]> = [
    [d, h], [d, h], // ±x
    [w, d], [w, d], // ±y
    [w, h], [w, h], // ±z
  ];
  for (let face = 0; face < 6; face++) {
    const [du, dv] = faceDims[face];
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v;
      uv.setXY(i, uv.getX(i) * du * UV_DENSITY, uv.getY(i) * dv * UV_DENSITY);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Attach a per-vertex colour (used by the vertex-coloured container material). */
function applyTint(geo: THREE.BufferGeometry, tint: number | undefined): void {
  const c = new THREE.Color();
  if (tint !== undefined) c.setHex(tint, THREE.SRGBColorSpace);
  else c.setRGB(1, 1, 1);
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

export interface MergedGroup {
  readonly material: MaterialKey;
  readonly geometry: THREE.BufferGeometry;
  readonly solids: Solid[];
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
}

/**
 * Group solids by material key and merge each group into a single geometry.
 *
 * Shadow flags are resolved per group: a group casts/receives if any of its
 * solids do (merged meshes share one flag). Solids are grouped so this stays
 * consistent — dressing that should not cast (lamps, floor paint) uses its own
 * material key and therefore its own group.
 */
export function mergeSolidsByMaterial(solids: readonly Solid[]): MergedGroup[] {
  const groups = new Map<MaterialKey, Solid[]>();
  for (const s of solids) {
    const list = groups.get(s.material);
    if (list) list.push(s);
    else groups.set(s.material, [s]);
  }

  const result: MergedGroup[] = [];
  for (const [material, groupSolids] of groups) {
    const needsColor = groupSolids.some((s) => s.tint !== undefined);
    const parts = groupSolids.map((s) => {
      const geo = boxGeometry(s);
      if (needsColor) applyTint(geo, s.tint);
      return geo;
    });
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error(`failed to merge geometry group "${material}"`);
    for (const p of parts) p.dispose();
    merged.computeBoundingSphere();
    result.push({
      material,
      geometry: merged,
      solids: groupSolids,
      castShadow: groupSolids.some((s) => s.castShadow),
      receiveShadow: groupSolids.some((s) => s.receiveShadow),
    });
  }
  return result;
}
