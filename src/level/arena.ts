/**
 * The arena — one source of truth for geometry AND collision.
 *
 * Issue #32 restricts the world to axis-aligned boxes: the player motor is
 * verified on flat floors, steps and vertical walls but NOT on slopes, so a box
 * world makes the unverified solver unreachable rather than merely untested.
 *
 * The prior level attempt (#8) authored collision *separately* from the rendered
 * meshes, and the two drifted — an invisible pipe-bank the player hit but could
 * not see, and rails offset from what they collided with. This module refuses
 * that failure mode structurally: every solid below is a single `Solid` record
 * from which BOTH the render mesh (see `geometry.ts`) and the `StaticBox`
 * collision (see `staticWorld.ts`) are derived. They cannot disagree because
 * they are the same data, and `correspondence.ts` proves it against the actual
 * geometry rather than asserting it.
 *
 * This file is deliberately free of `three` and of any browser API so the
 * correspondence proof can rebuild the exact world in Node.
 *
 * Scale: a compact blue-hour cargo bay, ~24 m × 21 m, tuned for one player
 * against one enemy. Small and dense beats large and thin.
 */

export type Vec3 = readonly [number, number, number];

/** Collision surface identity — must be one of the core contract's four. */
export type SurfaceMaterial = 'concrete' | 'metal' | 'wood' | 'dirt';

/** Visual material key, resolved to a `three` material in `materials.ts`. */
export type MaterialKey =
  | 'concrete'
  | 'concreteDark'
  | 'galvanized'
  | 'darkMetal'
  | 'rust'
  | 'wood'
  | 'container'
  | 'safety'
  | 'lampWarm'
  | 'beacon';

/**
 * One axis-aligned box. The unit of the whole level.
 *
 * `collide: true` contributes a `StaticBox`; `collide: false` is render-only
 * dressing (lamps, overhead pipes, painted floor) that a player never treats as
 * cover. The honesty rule this file keeps: nothing that reads as body-height
 * cover is ever `collide: false`.
 */
export interface Solid {
  readonly id: string;
  readonly min: Vec3;
  readonly max: Vec3;
  readonly material: MaterialKey;
  readonly surface: SurfaceMaterial;
  readonly collide: boolean;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  /** Optional linear-space tint baked as a vertex colour (container palette). */
  readonly tint?: number;
}

export interface LightSpec {
  readonly kind: 'directional' | 'hemisphere' | 'point';
  readonly color: number;
  readonly intensity: number;
  readonly position?: Vec3;
  /** Hemisphere ground colour. */
  readonly groundColor?: number;
  /** Point-light falloff distance / decay. */
  readonly distance?: number;
  readonly decay?: number;
  readonly castShadow?: boolean;
}

export interface ShotSpec {
  readonly name: string;
  readonly position: Vec3;
  readonly lookAt: Vec3;
  /** Optional vertical FOV override; defaults to the engine camera's 75°. */
  readonly fov?: number;
  readonly caption: string;
}

export interface ArenaDefinition {
  readonly solids: readonly Solid[];
  readonly lights: readonly LightSpec[];
  readonly shots: readonly ShotSpec[];
  /** Player capsule feet position. Eye height is owned by PlayerSystem. */
  readonly playerSpawn: Vec3;
  /** Enemy ground position. */
  readonly enemySpawn: Vec3;
  /** Authored solids the enemy may rank as cover; every id must collide. */
  readonly enemyCoverIds: readonly string[];
  readonly fog: { readonly color: number; readonly density: number };
}

// ── Authoring helpers ──────────────────────────────────────────────────────

function box(
  id: string,
  center: Vec3,
  size: Vec3,
  material: MaterialKey,
  surface: SurfaceMaterial,
  opts: Partial<Pick<Solid, 'collide' | 'castShadow' | 'receiveShadow' | 'tint'>> = {},
): Solid {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  return {
    id,
    min: [cx - hx, cy - hy, cz - hz],
    max: [cx + hx, cy + hy, cz + hz],
    material,
    surface,
    collide: opts.collide ?? true,
    castShadow: opts.castShadow ?? true,
    receiveShadow: opts.receiveShadow ?? true,
    tint: opts.tint,
  };
}

/** A box sitting ON the floor: its base is y=0, height grows upward. */
function onFloor(
  id: string,
  centerXZ: readonly [number, number],
  footprint: readonly [number, number],
  height: number,
  material: MaterialKey,
  surface: SurfaceMaterial,
  opts: Partial<Pick<Solid, 'collide' | 'castShadow' | 'receiveShadow' | 'tint'>> = {},
): Solid {
  const [cx, cz] = centerXZ;
  const [w, d] = footprint;
  return box(id, [cx, height / 2, cz], [w, height, d], material, surface, opts);
}

// ── Layout constants ────────────────────────────────────────────────────────
// Interior play area is bounded by the inner faces of the four walls.
const X_MIN = -12;
const X_MAX = 12;
const Z_MIN = -20; // far (north) wall inner face — the objective end
const Z_MAX = 1; //  near (south) wall inner face — the spawn end
const WALL_T = 0.6;
const FLOOR_DROP = 0.6;

// Faded ISO-container palette (linear-ish sRGB hexes) — carries the silhouette
// colour. Weathered, desaturated: harbour blue, oxide red, faded teal, ochre.
const CONTAINER = {
  blue: 0x2f4a57,
  rust: 0x7a4030,
  teal: 0x36564f,
  ochre: 0x8a6a2f,
  grey: 0x49555a,
} as const;

/**
 * Builds the arena. Pure: returns data only, no `three`, no DOM. Called once by
 * the runtime system and again, identically, by the correspondence proof.
 */
export function buildArena(): ArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => {
    for (const solid of s) solids.push(solid);
  };

  // ── Ground ────────────────────────────────────────────────────────────────
  // One slab under everything, its top face at y=0. Extends under the walls so
  // there is no seam at the perimeter.
  push(box(
    'floor',
    [(X_MIN + X_MAX) / 2, -FLOOR_DROP / 2, (Z_MIN + Z_MAX) / 2],
    [(X_MAX - X_MIN) + WALL_T * 2, FLOOR_DROP, (Z_MAX - Z_MIN) + WALL_T * 2],
    'concrete',
    'concrete',
    { castShadow: false },
  ));

  // ── Perimeter walls ─────────────────────────────────────────────────────
  // North is a tall warehouse backdrop; the others are lower so the dusk sky
  // reads over them and the silhouette varies rather than boxing the player in.
  const northTop = 6.0;
  const sideTop = 3.6;
  const southTop = 3.2;
  // North wall in two piers flanking a dark service opening, for depth.
  const openW = 3.2;
  const northSpan = (X_MAX - X_MIN) + WALL_T * 2;
  const pierW = (northSpan - openW) / 2;
  push(
    onFloor('wall-n-west', [X_MIN - WALL_T / 2 + pierW / 2, Z_MIN - WALL_T / 2], [pierW, WALL_T], northTop, 'concrete', 'concrete'),
    onFloor('wall-n-east', [X_MAX + WALL_T / 2 - pierW / 2, Z_MIN - WALL_T / 2], [pierW, WALL_T], northTop, 'concrete', 'concrete'),
    // Lintel over the opening so the gap reads as a doorway, not a missing wall.
    box('wall-n-lintel', [(X_MIN + X_MAX) / 2, 4.6, Z_MIN - WALL_T / 2], [openW, 2.8, WALL_T], 'concreteDark', 'concrete'),
  );
  push(
    onFloor('wall-s', [(X_MIN + X_MAX) / 2, Z_MAX + WALL_T / 2], [northSpan, WALL_T], southTop, 'concrete', 'concrete'),
    onFloor('wall-w', [X_MIN - WALL_T / 2, (Z_MIN + Z_MAX) / 2], [WALL_T, (Z_MAX - Z_MIN)], sideTop, 'concrete', 'concrete'),
    onFloor('wall-e', [X_MAX + WALL_T / 2, (Z_MIN + Z_MAX) / 2], [WALL_T, (Z_MAX - Z_MIN)], sideTop, 'concrete', 'concrete'),
  );

  // ── Central hard cover: a staggered container stack ─────────────────────
  // Breaks the straight spawn→objective sightline and forces a left/right
  // choice. Axis-aligned; the long axis is chosen per box to build an L.
  const CH = 2.6; // container height
  const CL = 6.05; // long dimension
  const CW = 2.44; // short dimension
  push(
    onFloor('cont-a', [-1.8, -9.3], [CL, CW], CH, 'container', 'metal', { tint: CONTAINER.blue }),
    box('cont-b', [-1.4, CH + CH / 2, -9.3], [CL, CH, CW], 'container', 'metal', { tint: CONTAINER.ochre }),
    onFloor('cont-c', [2.9, -7.6], [CW, CL], CH, 'container', 'metal', { tint: CONTAINER.rust }),
  );

  // ── West lane cover: low concrete + a mid crate stack ───────────────────
  // Chest-high barriers (1.1 m) give the crouch-and-peek rhythm; the crates add
  // a taller broken silhouette mid-lane.
  push(
    onFloor('jersey-w1', [-8.6, -4.5], [2.4, 0.7], 1.1, 'concrete', 'concrete'),
    onFloor('jersey-w2', [-6.4, -15.5], [2.4, 0.7], 1.1, 'concreteDark', 'concrete'),
    onFloor('crate-w1', [-9.1, -11.6], [1.4, 1.4], 1.4, 'wood', 'wood'),
    onFloor('crate-w2', [-7.7, -11.9], [1.3, 1.3], 1.3, 'wood', 'wood'),
    box('crate-w3', [-9.1, 1.4 + 0.65, -11.6], [1.3, 1.3, 1.3], 'wood', 'wood'),
  );

  // ── East flank: a raised overwatch deck reached by real steps ───────────
  // The player motor (PR #40) is verified on steps up to maxStepHeight = 0.34 m
  // but NOT on slopes, so verticality is a stair of axis-aligned treads. Issue
  // #43: the treads MUST ascend toward the deck (tallest tread flush with the
  // deck top) and every northward rise MUST stay <= 0.34 m, or the climb is
  // geometrically unreachable. `fixtures/deck-traversal` drives the real motor
  // from floor to deck and proves it; keep the two in sync.
  const deckTop = 1.6;
  const deckXmin = 5.6;
  const deckZmin = -16.5;
  const deckZmax = -10.0; // south (spawn-facing) edge of the deck
  push(box(
    'deck',
    [(deckXmin + X_MAX) / 2, deckTop - 0.2, (deckZmin + deckZmax) / 2],
    [X_MAX - deckXmin, 0.4, deckZmax - deckZmin],
    'galvanized',
    'metal',
  ));
  // Ascending treads climbing NORTH up to the deck. i=0 is the TOP tread, flush
  // with the deck top and contiguous with its south edge; each tread further
  // south is one `rise` lower. rise = deckTop/6 = 0.267 m < maxStepHeight
  // (0.34 m) with margin, and the tallest tread equals deck height, so the last
  // move onto the deck is flat, not a wall.
  const stepCount = 6;
  const rise = deckTop / stepCount; // 0.2667 m per step, < 0.34 m
  const tread = 0.5; // tread depth (Z), metres
  const stairXCenter = 7.4;
  const stairWidth = 2.2; // x[6.30, 8.50]
  for (let i = 0; i < stepCount; i++) {
    const h = deckTop - rise * i; // i=0 -> 1.600 (deck height), i=5 -> 0.267
    const zCenter = deckZmax + tread * i + tread / 2; // i=0 -> -9.75 (flush to deck), stepping south
    push(onFloor(`step-${i}`, [stairXCenter, zCenter], [stairWidth, tread], h, 'galvanized', 'metal'));
  }
  // Deck parapets, 1.0 m above the deck (chest-high when standing on it):
  //  - west edge, faces the west lane (stops short of the south edge so the
  //    south rail can own the corner without overlapping it);
  //  - south edge, faces spawn, but SPLIT to leave a doorway over the stair so
  //    the climb actually lands on the deck. Issue #43: the prior single-span
  //    south parapet walled the top of the stairs off.
  const gapXMin = stairXCenter - stairWidth / 2; // 6.30 (stair west edge)
  const gapXMax = stairXCenter + stairWidth / 2 + 0.30; // 8.80 (east clearance)
  push(
    box('parapet-w', [deckXmin + 0.2, deckTop + 0.5, (deckZmin + (deckZmax - 0.4)) / 2], [0.4, 1.0, (deckZmax - 0.4) - deckZmin], 'darkMetal', 'metal'),
    box('parapet-s-w', [(deckXmin + gapXMin) / 2, deckTop + 0.5, deckZmax - 0.2], [gapXMin - deckXmin, 1.0, 0.4], 'darkMetal', 'metal'),
    box('parapet-s-e', [(gapXMax + X_MAX) / 2, deckTop + 0.5, deckZmax - 0.2], [X_MAX - gapXMax, 1.0, 0.4], 'darkMetal', 'metal'),
  );

  // ── Objective end: a loading-dock ledge with the beacon terminal ────────
  // Waist-high cover the defender can hold behind, and the arena's focal point.
  push(
    onFloor('dock-obj', [0, -19.3], [9, 1.4], 0.9, 'concrete', 'concrete'),
    onFloor('jersey-n1', [1.6, -16.8], [2.4, 0.7], 1.1, 'concrete', 'concrete'),
    onFloor('pallet-n', [3.8, -15.4], [1.2, 1.0], 1.15, 'wood', 'wood'),
    onFloor('drum-n1', [-0.4, -17.6], [0.7, 0.7], 1.0, 'rust', 'metal'),
  );

  // ── Render-only dressing (never cover) ──────────────────────────────────
  // Wall lamp housings (warm practicals) — emissive, bloom sources.
  push(
    box('lamp-w', [X_MIN + 0.35, 3.0, -6.0], [0.5, 0.32, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
    box('lamp-e', [X_MAX - 0.35, 3.0, -13.5], [0.5, 0.32, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
    box('lamp-hang', [-1.4, 4.55, -9.3], [0.6, 0.28, 0.6], 'lampWarm', 'metal', { collide: false, castShadow: false }),
  );
  // Objective beacon on the dock — cool accent that draws the eye to the enemy
  // end and gives bloom a second, colder source against the warm practicals.
  push(
    box('beacon', [0, 1.55, -19.1], [0.5, 1.3, 0.5], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('beacon-cap', [0, 2.28, -19.1], [0.62, 0.12, 0.62], 'darkMetal', 'metal', { collide: false, castShadow: false }),
  );
  // Painted hazard bands — flush on the floor, pure colour to guide the eye.
  push(
    box('paint-deck', [8.8, 0.011, -9.4], [X_MAX - deckXmin, 0.02, 0.5], 'safety', 'concrete', { collide: false, castShadow: false, receiveShadow: false }),
    box('paint-obj', [0, 0.011, -17.4], [4.0, 0.02, 0.4], 'safety', 'concrete', { collide: false, castShadow: false, receiveShadow: false }),
  );

  // ── Lighting: blue-hour cool ambient, warm practicals ───────────────────
  // The directional key is aligned to the render pipeline's IBL sun direction
  // (-8,14,6) so the highlight on the metals agrees with the shadow it casts —
  // the same coherence the ProceduralSky/RenderSystem were built around.
  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xffe6c4, intensity: 2.5, position: [-8, 14, 6], castShadow: true },
    { kind: 'hemisphere', color: 0x7d97c6, groundColor: 0x2a2219, intensity: 0.62 },
    // Warm sodium pools at the wall lamps and the hung lamp over the cluster.
    { kind: 'point', color: 0xff9a44, intensity: 26, position: [X_MIN + 0.7, 2.95, -6.0], distance: 15, decay: 2 },
    { kind: 'point', color: 0xff9a44, intensity: 22, position: [X_MAX - 0.7, 2.95, -13.5], distance: 14, decay: 2 },
    { kind: 'point', color: 0xffb060, intensity: 30, position: [-1.4, 4.4, -9.3], distance: 16, decay: 2 },
    // Cold accent at the objective beacon.
    { kind: 'point', color: 0x4fd6ea, intensity: 16, position: [0, 2.1, -19.1], distance: 10, decay: 2 },
  ];

  // ── Camera shots (evidence hooks) ───────────────────────────────────────
  const shots: ShotSpec[] = [
    {
      name: 'spawn', position: [0, 1.7, -1.6], lookAt: [-1.0, 1.4, -16],
      caption: 'Opening read from the player spawn: the container stack breaks the straight line to the objective and forces a left/right choice.',
    },
    {
      name: 'lane_west', position: [-8.6, 1.62, -2.6], lookAt: [-7.5, 1.35, -16],
      caption: 'Down the west lane: chest-high concrete and a broken crate stack give the crouch-and-peek rhythm.',
    },
    {
      name: 'overwatch', position: [8.9, 3.26, -12.2], lookAt: [-1.6, 0.9, -18.2],
      caption: 'Standing eye height (deck top 1.60 m + 1.66 m eye) on the now-reachable overwatch deck, north-west over the parapet onto the beacon objective. The traversal fixture proves a player can stand here.',
    },
    {
      name: 'stairs', position: [9.15, 1.62, -4.7], lookAt: [7.1, 1.15, -10.4],
      caption: 'The corrected access stair: six 0.267 m treads (each rise < the 0.34 m motor step limit) climbing north-west to the deck through the parapet doorway gap. deck-traversal.report.json proves the shipping PlayerMotor walks floor -> deck up these exact boxes.',
    },
    {
      name: 'objective', position: [1.6, 1.7, -15.4], lookAt: [0, 1.6, -1.5],
      caption: 'The enemy hold looking back toward spawn — the beacon end is exposed to the east deck.',
    },
    {
      name: 'silhouette', position: [-11.0, 2.4, 0.2], lookAt: [7.0, 2.2, -17],
      caption: 'Wide diagonal: the whole silhouette — stacked containers, stepped deck, warm practicals against the blue hour.',
    },
    {
      name: 'materials', position: [-0.6, 1.35, -6.2], lookAt: [-1.8, 1.3, -9.4],
      caption: 'Close on the container faces and floor: procedural concrete/painted-metal/wood variation catching the IBL.',
    },
    {
      name: 'grounding', position: [-5.9, 2.5, -8.2], lookAt: [-8.5, 0.12, -12.2],
      caption: 'Low three-quarter look across the west-lane crate and jersey bases: the authored contact marks sit under each floor-standing solid on its exact footprint, so the cover reads as resting on the floor rather than floating. Compare with ?contact=0.',
    },
  ];

  return {
    solids,
    lights,
    shots,
    playerSpawn: [0, 0, -1.6],
    enemySpawn: [-9, 0, -13],
    enemyCoverIds: [
      'cont-a',
      'cont-c',
      'jersey-w2',
      'crate-w1',
      'parapet-w',
    ],
    fog: { color: 0x223041, density: 0.026 },
  };
}
