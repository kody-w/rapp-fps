/**
 * Procedural structural dressing for the cargo containers (issue #67).
 *
 * The defect this fixes is that `cont-a/b/c` shipped as bare `BoxGeometry`
 * cuboids: the only "container-ness" was a sine brightness stripe painted into
 * the albedo (see `panelAlbedo`), while the bump/roughness maps were unrelated
 * generic metal noise. A shipping-container reads as a container because of its
 * *ironwork* — corner castings, top and bottom side/end rails, and an inset
 * end-door with locking bars, hinges and handles — none of which was present.
 *
 * This module authors that ironwork as real geometry, and it does so under the
 * same discipline as the #66 contact-shadow layer it sits beside:
 *
 *   - Every part is DERIVED from the container's own `Solid` min/max — the exact
 *     record that produces the body geometry and the collider. Orientation
 *     (which way the box is long, hence where the rails run and the doors face)
 *     is inferred from the bounds, never hand-typed, so the dressing cannot drift
 *     from the box the player actually stands against.
 *   - It is RENDER-ONLY. The dressing is built into its own meshes and is *not*
 *     added to the correspondence `groups`, so the 5/5 render==collision proof is
 *     untouched: the collider is still exactly the container body box, and the
 *     centimetre-scale ironwork carries no collision of its own.
 *   - Cost is bounded by construction: TWO merged draws (a `structure` mesh and a
 *     `hardware` mesh), ZERO new textures (the parts are small steel fittings lit
 *     by the pipeline IBL — the one new texture in #67 is the rib normal map, and
 *     it lives in `materials.ts`), an enforced triangle ceiling, and no per-frame
 *     allocation (everything is built once).
 *
 * Like `geometry.ts` this runs headlessly on `three`'s geometry classes, so the
 * selection, orientation and footprint are provable in Node without a renderer.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ArenaDefinition, Solid } from './arena.js';

/**
 * The dressing only ever applies to solids drawn with the `container` material.
 * That is the explicit, auditable selector: it is a real field on the `Solid`
 * record (not a name-match heuristic), so crates (`wood`), drums (`rust`), the
 * floor and walls (`concrete`) and every other prop are rejected by definition.
 */
const CONTAINER_MATERIAL = 'container';

/**
 * Hard resource ceiling (issue #67: "set/enforce triangle/resource ceiling").
 * Each fitting is a 12-triangle box; the assemblies below total ~34 boxes per
 * container (~1224 tris for the three), so this ceiling leaves headroom for
 * art tuning while still failing LOUD if the dressing ever balloons.
 */
export const MAX_DRESSING_TRIANGLES = 3000;

/** Maximum outward protrusion of any fitting beyond the body face, in metres.
 *  "Centimetre-scale" per the issue — nothing sticks out more than 10 cm, and
 *  no fitting extends above the top face or below the base plane at all. */
export const MAX_DRESSING_PROTRUSION = 0.1;

type Axis = 'x' | 'z';
type Vec3 = readonly [number, number, number];

/** One authored fitting as a world-space AABB — the pure, testable unit. */
export interface DressingPart {
  readonly kind: string;
  readonly group: 'structure' | 'hardware';
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A container's derived assembly: orientation + every fitting, from bounds. */
export interface ContainerAssembly {
  readonly id: string;
  readonly min: Vec3;
  readonly max: Vec3;
  /** The box's long horizontal axis, inferred from the footprint. */
  readonly longAxis: Axis;
  /** The short horizontal axis (rails run across it; doors face along it). */
  readonly shortAxis: Axis;
  /** The world coordinate of the door end (the MAX face of the long axis). */
  readonly doorEnd: number;
  readonly parts: readonly DressingPart[];
}

export interface DressingEligibility {
  readonly id: string;
  readonly eligible: boolean;
  readonly reason: string;
}

/** Deterministic, auditable eligibility for a single solid. */
export function classifyContainerDressing(solid: Solid): DressingEligibility {
  if (solid.material !== CONTAINER_MATERIAL) {
    return { id: solid.id, eligible: false, reason: `not a container (material=${solid.material})` };
  }
  return { id: solid.id, eligible: true, reason: 'container' };
}

/** Every solid classified in declaration order — the audit trail for the fixture. */
export function describeContainerDressing(def: ArenaDefinition): DressingEligibility[] {
  return def.solids.map(classifyContainerDressing);
}

/** The containers that receive dressing, in declaration order. */
export function selectContainerSolids(def: ArenaDefinition): Solid[] {
  return def.solids.filter((s) => classifyContainerDressing(s).eligible);
}

// ── Fitting proportions (metres). All small, all derived — none hand-placed. ──
const FRAME_OUT = 0.035; //  frame/casting/rail protrusion beyond the body face
const CAST = 0.16; //        corner casting cube reach into the body
const POST = 0.11; //        corner-post reach into the body (slimmer than casting)
const RAIL = 0.11; //        side/end rail height band
const RAIL_IN = 0.06; //     rail reach into the body
const DOOR_OUT = 0.012; //   door leaf protrusion (< FRAME_OUT, so it reads inset)
const DOOR_IN = 0.04; //     door leaf reach into the body
const SEAM = 0.02; //        gap between the two door leaves
const BAR_OUT = 0.05; //     locking-bar protrusion (proud of the frame)
const BAR_HALF = 0.025; //   locking-bar half width
const HINGE_OUT = 0.045;
const HANDLE_OUT = 0.085; //  cam handle reach (the single deepest fitting)

/**
 * Derive a container's full fitting set from its `Solid` bounds. Pure: given the
 * same solid it always returns the same parts, so orientation, door end and every
 * footprint are provable in the fixture without touching the GPU.
 */
export function describeContainerAssembly(solid: Solid): ContainerAssembly {
  const [x0, y0, z0] = solid.min;
  const [x1, y1, z1] = solid.max;
  const sx = x1 - x0;
  const sz = z1 - z0;
  const longAxis: Axis = sx >= sz ? 'x' : 'z';
  const shortAxis: Axis = longAxis === 'x' ? 'z' : 'x';

  // Work in (along, across, y): `a` spans the long axis, `c` the short axis.
  const a0 = longAxis === 'x' ? x0 : z0;
  const a1 = longAxis === 'x' ? x1 : z1;
  const c0 = longAxis === 'x' ? z0 : x0;
  const c1 = longAxis === 'x' ? z1 : x1;
  const doorEnd = a1; // door faces the MAX end of the long axis (deterministic)

  const parts: DressingPart[] = [];
  const push = (
    kind: string,
    group: 'structure' | 'hardware',
    aLo: number, aHi: number,
    cLo: number, cHi: number,
    yLo: number, yHi: number,
  ): void => {
    // Normalise each interval so a part is always a valid AABB regardless of the
    // direction its range was authored in (e.g. a hinge measured inboard from an
    // outer edge), then map (along, across) back to world (x, z).
    const a0m = Math.min(aLo, aHi);
    const a1m = Math.max(aLo, aHi);
    const c0m = Math.min(cLo, cHi);
    const c1m = Math.max(cLo, cHi);
    const y0m = Math.min(yLo, yHi);
    const y1m = Math.max(yLo, yHi);
    const min: Vec3 = longAxis === 'x' ? [a0m, y0m, c0m] : [c0m, y0m, a0m];
    const max: Vec3 = longAxis === 'x' ? [a1m, y1m, c1m] : [c1m, y1m, a1m];
    parts.push({ kind, group, min, max });
  };

  const aEnds = [{ v: a0, sign: -1 }, { v: a1, sign: 1 }] as const;
  const cEnds = [{ v: c0, sign: -1 }, { v: c1, sign: 1 }] as const;
  const yBands: Array<[number, number]> = [[y0, y0 + CAST], [y1 - CAST, y1]];

  // Corner castings: iconic ISO cubes at all 8 corners, proud only horizontally
  // (flush top/bottom so nothing pokes below the floor or above the stack).
  for (const ae of aEnds) {
    for (const ce of cEnds) {
      const aR: [number, number] = ae.sign < 0 ? [a0 - FRAME_OUT, a0 + CAST] : [a1 - CAST, a1 + FRAME_OUT];
      const cR: [number, number] = ce.sign < 0 ? [c0 - FRAME_OUT, c0 + CAST] : [c1 - CAST, c1 + FRAME_OUT];
      for (const yb of yBands) push('casting', 'structure', aR[0], aR[1], cR[0], cR[1], yb[0], yb[1]);
    }
  }

  // Corner posts: full-height bars connecting the castings (slimmer footprint).
  for (const ae of aEnds) {
    for (const ce of cEnds) {
      const aR: [number, number] = ae.sign < 0 ? [a0 - FRAME_OUT, a0 + POST] : [a1 - POST, a1 + FRAME_OUT];
      const cR: [number, number] = ce.sign < 0 ? [c0 - FRAME_OUT, c0 + POST] : [c1 - POST, c1 + FRAME_OUT];
      push('post', 'structure', aR[0], aR[1], cR[0], cR[1], y0, y1);
    }
  }

  // Side rails: run the long axis on both long faces, top and bottom.
  for (const ce of cEnds) {
    const cR: [number, number] = ce.sign < 0 ? [c0 - FRAME_OUT, c0 + RAIL_IN] : [c1 - RAIL_IN, c1 + FRAME_OUT];
    push('side-rail', 'structure', a0 + CAST, a1 - CAST, cR[0], cR[1], y0, y0 + RAIL);
    push('side-rail', 'structure', a0 + CAST, a1 - CAST, cR[0], cR[1], y1 - RAIL, y1);
  }

  // End rails: run the short axis on both end faces, top and bottom. On the door
  // end these are the door header and sill.
  for (const ae of aEnds) {
    const aR: [number, number] = ae.sign < 0 ? [a0 - FRAME_OUT, a0 + RAIL_IN] : [a1 - RAIL_IN, a1 + FRAME_OUT];
    push('end-rail', 'structure', aR[0], aR[1], c0 + CAST, c1 - CAST, y0, y0 + RAIL);
    push('end-rail', 'structure', aR[0], aR[1], c0 + CAST, c1 - CAST, y1 - RAIL, y1);
  }

  // ── Door end (a1): two inset leaves, framed by the posts/header/sill above ──
  const cMid = (c0 + c1) / 2;
  const leafLo = c0 + CAST;
  const leafHi = c1 - CAST;
  const leafYLo = y0 + RAIL;
  const leafYHi = y1 - RAIL;
  const leaves: Array<[number, number]> = [
    [leafLo, cMid - SEAM / 2],
    [cMid + SEAM / 2, leafHi],
  ];
  for (const [lc0, lc1] of leaves) {
    push('door-leaf', 'structure', a1 - DOOR_IN, a1 + DOOR_OUT, lc0, lc1, leafYLo, leafYHi);
  }

  // Hardware: 2 locking bars per leaf, a cam handle on each, hinges at the outer
  // edge of each leaf (top and bottom).
  for (const [lc0, lc1] of leaves) {
    const lw = lc1 - lc0;
    const barCs = [lc0 + lw * 0.28, lc0 + lw * 0.72];
    for (const bc of barCs) {
      push('locking-bar', 'hardware', a1 - 0.02, a1 + BAR_OUT, bc - BAR_HALF, bc + BAR_HALF, leafYLo + 0.05, leafYHi - 0.05);
      const ymid = (leafYLo + leafYHi) / 2;
      // Cam handle: sticks out past the bar and offsets to one side of it.
      push('handle', 'hardware', a1 + BAR_OUT - 0.02, a1 + HANDLE_OUT, bc + BAR_HALF, bc + BAR_HALF + 0.11, ymid - 0.03, ymid + 0.03);
    }
    // Hinges on the leaf's outer edge (the one nearest a corner post).
    const outerC = Math.abs(lc0 - leafLo) < Math.abs(lc1 - leafHi) ? lc0 : lc1;
    const hs = outerC < cMid ? 1 : -1;
    for (const hy of [leafYLo + 0.18, leafYHi - 0.18]) {
      push('hinge', 'hardware', a1 - 0.01, a1 + HINGE_OUT, outerC, outerC + hs * 0.09, hy - 0.06, hy + 0.06);
    }
  }

  return { id: solid.id, min: solid.min, max: solid.max, longAxis, shortAxis, doorEnd, parts };
}

/** Every container's assembly, in declaration order. */
export function describeContainerAssemblies(def: ArenaDefinition): ContainerAssembly[] {
  return selectContainerSolids(def).map(describeContainerAssembly);
}

export interface ContainerDressingLayer {
  /** The single merged, vertex-coloured ironwork mesh (structure + hardware). */
  readonly mesh: THREE.Mesh;
  /** Always `[mesh]` — the meshes to add to / remove from the scene. */
  readonly meshes: readonly THREE.Mesh[];
  readonly assemblies: readonly ContainerAssembly[];
  readonly triangleCount: number;
  dispose(): void;
}

// Two-tone steel, carried as a vertex colour so the whole ironwork ships in ONE
// merged mesh / ONE material: bright galvanised castings, posts and rails; dark
// oxidised locking bars, hinges and handles.
const PART_COLOR: Record<DressingPart['group'], number> = {
  structure: 0x59626a,
  hardware: 0x2e3236,
};

/** A world-positioned box for one part, tinted by its group (mapless steel). */
function partGeometry(part: DressingPart): THREE.BufferGeometry {
  const w = part.max[0] - part.min[0];
  const h = part.max[1] - part.min[1];
  const d = part.max[2] - part.min[2];
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(
    (part.min[0] + part.max[0]) / 2,
    (part.min[1] + part.max[1]) / 2,
    (part.min[2] + part.max[2]) / 2,
  );
  const c = new THREE.Color().setHex(PART_COLOR[part.group], THREE.SRGBColorSpace);
  const n = geo.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function triangles(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return (index ? index.count : geometry.getAttribute('position').count) / 3;
}

/**
 * Build the dressing layer for a set of already-selected container solids. The
 * caller owns selection (`selectContainerSolids`) so the same list and the same
 * assemblies can be audited without building GPU objects.
 *
 * All ~34 fittings per container merge into ONE vertex-coloured mesh, so the
 * whole ironwork is a single added material draw — which is at most two GPU draw
 * calls even under the shipping RenderSystem's opaque depth-prepass, inside the
 * #67 "≤2 added merged material draws" budget. Zero generated textures (the one
 * new #67 texture is the rib normal in materials.ts; these steel fittings are
 * mapless, lit by the pipeline IBL).
 *
 * Enforces {@link MAX_DRESSING_TRIANGLES}: throws before returning if the merged
 * geometry exceeds the ceiling, so a runaway assembly fails loudly rather than
 * quietly blowing the budget.
 */
export function createContainerDressingLayer(solids: readonly Solid[]): ContainerDressingLayer {
  const assemblies = solids.map(describeContainerAssembly);
  const allParts = assemblies.flatMap((a) => a.parts);

  const geos = allParts.map(partGeometry);
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('failed to merge container dressing geometry');
  merged.computeBoundingSphere();
  const triangleCount = triangles(merged);
  if (triangleCount > MAX_DRESSING_TRIANGLES) {
    merged.dispose();
    throw new Error(
      `container dressing exceeds triangle ceiling: ${triangleCount} > ${MAX_DRESSING_TRIANGLES}`,
    );
  }

  // One mapless, vertex-coloured steel material, lit by the pipeline IBL.
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.52,
    metalness: 0.82,
  });

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'arena:container-dressing';
  // Centimetre-scale ironwork: it does NOT cast into the VSM shadow map (its
  // sub-texel features contribute nothing there, and the container body already
  // casts), so it stays a single opaque mesh — one shadow-free added draw. It
  // still receives the scene shadow.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    meshes: [mesh],
    assemblies,
    triangleCount,
    dispose(): void {
      mesh.parent?.remove(mesh);
      merged.dispose();
      material.dispose();
    },
  };
}
