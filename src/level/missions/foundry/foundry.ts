/**
 * Mission 3 — "Foundry Last Light".
 *
 * A pure, `three`-free, DOM-free factory that returns an `ArenaDefinition`
 * (the shared level contract in `../../arena.ts`) describing a structurally
 * distinct finale: a warm furnace hall, a central casting lane lined with
 * cover, heavy machine plinths, a stair-accessed control gantry and a defended
 * final shutdown objective on top of it.
 *
 * It is NOT a reskin of the cargo bay (`buildArena`). It shares nothing but the
 * *contract*: the same one-source discipline (every solid below produces BOTH
 * the render mesh via `../../geometry.ts` and the `StaticBox` collision via
 * `../../staticWorld.ts`, and `../../correspondence.ts` proves they agree
 * against the real GPU buffers), and the same axis-aligned-box restriction the
 * shipping `PlayerMotor` is verified against (issue #32): every solid is an AABB,
 * every floor normal is +Y and every wall normal is horizontal, so the
 * unverified slope solver stays unreachable rather than merely untested.
 *
 * Two decisions keep it honest and reachable:
 *   1. It uses ONLY the existing `MaterialKey`/`SurfaceMaterial` vocabulary, so
 *      the shared `ArenaLevel`/materials/dressing/contact layers accept it with
 *      no edit to any shared file — the parent adapts the factory, nothing else.
 *   2. Every rise on the control-gantry stair is `deckTop/stepCount = 0.2833 m`,
 *      strictly under the motor's `maxStepHeight` (0.34 m), and the top tread is
 *      flush with the gantry, so the last move onto the platform is flat. The
 *      `fixtures/foundry-route` harness drives the shipping motor floor → lane →
 *      stair → console to prove a human walks it, with a sabotaged negative
 *      control that must fail.
 *
 * Scale: a wide, shallow furnace hall, ~26 m × 22 m — deliberately different
 * bounds, box count, id space, route and sightline signature from the cargo
 * bay, asserted distinct in `fingerprint.ts`. It imports nothing from any other
 * mission (in particular it does NOT depend on the relay combat-lane branch).
 */

import type {
  ArenaDefinition,
  LightSpec,
  MaterialKey,
  ShotSpec,
  Solid,
  SurfaceMaterial,
  Vec3,
} from '../../arena.js';

/** Identity of the final shutdown objective — location + metadata the parent
 *  mission logic reads to place the interaction and win condition. */
export interface FinalObjective {
  readonly id: string;
  readonly kind: 'shutdown';
  /** World-space interaction point (centre of the console top face). */
  readonly location: Vec3;
  /** XZ half-extents used by the route proof's "reached" test. */
  readonly footprint: readonly [number, number];
  /** The elevated deck the objective stands on (feet must reach this height). */
  readonly gantryDeckId: string;
  readonly standHeight: number;
  readonly label: string;
  readonly detail: string;
}

/**
 * The Foundry arena. Structurally an `ArenaDefinition` (so `new ArenaLevel(def,
 * buildStaticWorld(def))` and every shared layer accept it unchanged), extended
 * with the mission metadata the parent needs: a SECOND player slot, the final
 * objective, and the deterministic traversal waypoints the route proof drives.
 */
export interface FoundryArenaDefinition extends ArenaDefinition {
  readonly mission: 'foundry-last-light';
  /** Two feet-based player spawns (two-slot co-op later). `playerSpawn` mirrors
   *  slot 0 to satisfy the single-spawn contract field. */
  readonly playerSpawns: readonly [Vec3, Vec3];
  readonly finalObjective: FinalObjective;
  /** Feet-space waypoints: spawn → casting lane → stair base → gantry → console.
   *  Pure geometry-derived guidance for the shipping-motor route proof. */
  readonly routeWaypoints: readonly Vec3[];
}

// ── Authoring helpers (mission-local; mirror the shared arena's discipline) ──

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

/** A box resting ON the floor: base at y=0, height grows upward. */
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
// Interior play area bounded by the inner faces of the four walls. Wide and
// shallow (26 × 22) — the opposite proportion to the cargo bay's tall corridor.
const X_MIN = -13;
const X_MAX = 13;
const Z_MIN = -17; // north (furnace + gantry) wall inner face
const Z_MAX = 5; //  south (spawn) wall inner face
const WALL_T = 0.6;
const FLOOR_DROP = 0.6;

// Control-gantry geometry, shared by the deck, the stair and the parapets so a
// layout change moves them together (and moves the route proof's targets with
// them, because that harness derives its waypoints from these solids).
const GANTRY_TOP = 1.7;
const GANTRY_X_MIN = X_MIN; //  abuts the west wall
const GANTRY_X_MAX = -4; //     east edge, faces the casting lane
const GANTRY_Z_MIN = Z_MIN; //  abuts the north wall
const GANTRY_Z_MAX = -9; //     south edge, faces spawn
const STAIR_STEP_COUNT = 6;
const STAIR_RISE = GANTRY_TOP / STAIR_STEP_COUNT; // 0.28333 m < maxStepHeight 0.34
const STAIR_TREAD = 0.5; //     tread depth along X (the climb axis)
const STAIR_Z_MIN = -12.0; //   stair doorway through the east parapet
const STAIR_Z_MAX = -9.6;

/**
 * Builds the Foundry arena. Pure: returns data only. Called once by the runtime
 * (through the shared `ArenaLevel`) and again, identically, by every proof.
 */
export function buildFoundry(): FoundryArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => {
    for (const solid of s) solids.push(solid);
  };

  // ── Ground ────────────────────────────────────────────────────────────────
  push(box(
    'floor',
    [(X_MIN + X_MAX) / 2, -FLOOR_DROP / 2, (Z_MIN + Z_MAX) / 2],
    [(X_MAX - X_MIN) + WALL_T * 2, FLOOR_DROP, (Z_MAX - Z_MIN) + WALL_T * 2],
    'concrete',
    'concrete',
    { castShadow: false },
  ));

  // ── Perimeter walls ─────────────────────────────────────────────────────
  // North is a tall furnace backdrop. The SOUTH wall is split into two piers and
  // a lintel so the two spawns read as entering the hall through a bay door —
  // the mirror image of the cargo bay, whose split was on the north.
  const northTop = 5.5;
  const sideTop = 4.0;
  const southTop = 3.4;
  const span = (X_MAX - X_MIN) + WALL_T * 2;
  push(onFloor('wall-n', [(X_MIN + X_MAX) / 2, Z_MIN - WALL_T / 2], [span, WALL_T], northTop, 'concrete', 'concrete'));
  const openW = 4.0;
  const pierW = (span - openW) / 2;
  push(
    onFloor('wall-s-west', [X_MIN - WALL_T / 2 + pierW / 2, Z_MAX + WALL_T / 2], [pierW, WALL_T], southTop, 'concrete', 'concrete'),
    onFloor('wall-s-east', [X_MAX + WALL_T / 2 - pierW / 2, Z_MAX + WALL_T / 2], [pierW, WALL_T], southTop, 'concrete', 'concrete'),
    box('wall-s-lintel', [(X_MIN + X_MAX) / 2, 4.2, Z_MAX + WALL_T / 2], [openW, 2.6, WALL_T], 'concreteDark', 'concrete'),
  );
  push(
    onFloor('wall-w', [X_MIN - WALL_T / 2, (Z_MIN + Z_MAX) / 2], [WALL_T, (Z_MAX - Z_MIN)], sideTop, 'concrete', 'concrete'),
    onFloor('wall-e', [X_MAX + WALL_T / 2, (Z_MIN + Z_MAX) / 2], [WALL_T, (Z_MAX - Z_MIN)], sideTop, 'concrete', 'concrete'),
  );

  // ── Furnace (north-east): the warm hall's heat and light source ──────────
  // A heavy iron hearth with a chimney stack and a side buttress. Collidable
  // mass that anchors the north-east and, with the gantry, walls the objective's
  // sightline from the spawns. The glowing tap and hood below are render-only.
  push(
    onFloor('furnace-base', [7.0, -13.5], [9.0, 5.5], 2.4, 'rust', 'metal'),
    box('furnace-stack', [8.5, 2.4 + 1.6, -14.0], [3.0, 3.2, 3.0], 'darkMetal', 'metal'),
    onFloor('furnace-buttress', [10.6, -9.2], [3.0, 2.6], 2.0, 'darkMetal', 'metal'),
  );

  // ── Casting lane cover (central spine): the crouch-and-peek rhythm ───────
  // Ingot moulds, a ladle car and a slag pot down the middle. Placed OFF the
  // reserved west-of-centre route corridor so the shipping motor threads them.
  push(
    onFloor('mould-1', [2.2, 0.6], [2.6, 0.8], 1.1, 'rust', 'metal'),
    onFloor('mould-2', [2.7, -3.2], [2.6, 0.8], 1.1, 'concreteDark', 'concrete'),
    onFloor('ladle-car', [2.0, -6.6], [2.4, 1.6], 1.35, 'darkMetal', 'metal'),
    onFloor('slag-pot', [-2.9, -4.1], [1.5, 1.5], 1.3, 'rust', 'metal'),
  );

  // ── Heavy machine plinths (flank the lane): the hard cover ───────────────
  // Press bases either side of the lane; the east press carries a ram head
  // stacked on top for a taller, broken silhouette. Big axis-aligned blocks —
  // the "heavy machinery" the design calls for, and the objective's occluders.
  push(
    onFloor('plinth-w1', [-6.4, -2.4], [3.2, 3.0], 2.2, 'concreteDark', 'concrete'),
    onFloor('plinth-w2', [-6.8, -7.0], [3.0, 3.0], 2.0, 'concreteDark', 'concrete'),
    onFloor('plinth-e1', [6.4, -2.4], [3.2, 3.0], 2.2, 'concreteDark', 'concrete'),
    box('press-head-e1', [6.4, 2.2 + 1.1, -2.4], [2.4, 2.2, 2.4], 'darkMetal', 'metal'),
    onFloor('plinth-e2', [6.8, -7.0], [3.0, 3.0], 2.0, 'concreteDark', 'concrete'),
  );

  // ── Control gantry (north-west, elevated): stair-accessed objective deck ──
  // A galvanized platform the objective sits on. The stair climbs WEST up its
  // east edge, the top tread flush with the deck top; the east parapet leaves a
  // doorway over the stair so the climb actually lands on the deck (the reach
  // failure the cargo bay's #43 fixed, kept structurally here).
  push(box(
    'gantry-deck',
    [(GANTRY_X_MIN + GANTRY_X_MAX) / 2, GANTRY_TOP - 0.2, (GANTRY_Z_MIN + GANTRY_Z_MAX) / 2],
    [GANTRY_X_MAX - GANTRY_X_MIN, 0.4, GANTRY_Z_MAX - GANTRY_Z_MIN],
    'galvanized',
    'metal',
  ));
  // Ascending treads climbing WEST to the gantry. i=0 is the TOP tread, flush
  // with the deck top and contiguous with its east edge; each tread further east
  // is one `rise` lower, so a walker approaching from the lane climbs onto the
  // deck. rise 0.2833 m < maxStepHeight, tallest tread == deck height.
  const stairZCenter = (STAIR_Z_MIN + STAIR_Z_MAX) / 2;
  const stairWidthZ = STAIR_Z_MAX - STAIR_Z_MIN;
  for (let i = 0; i < STAIR_STEP_COUNT; i++) {
    const h = GANTRY_TOP - STAIR_RISE * i; // i=0 -> 1.700 (deck height)
    const xCenter = GANTRY_X_MAX + STAIR_TREAD * i + STAIR_TREAD / 2; // i=0 flush to deck, stepping east
    push(onFloor(`step-${i}`, [xCenter, stairZCenter], [STAIR_TREAD, stairWidthZ], h, 'galvanized', 'metal'));
  }
  // Parapets, chest-high (1.0 m above the deck). South edge faces spawn; east
  // edge faces the lane but is SPLIT to leave the stair doorway.
  push(
    box('parapet-s', [(GANTRY_X_MIN + GANTRY_X_MAX) / 2, GANTRY_TOP + 0.5, GANTRY_Z_MAX - 0.2], [GANTRY_X_MAX - GANTRY_X_MIN, 1.0, 0.4], 'darkMetal', 'metal'),
    box('parapet-e-n', [GANTRY_X_MAX - 0.2, GANTRY_TOP + 0.5, (GANTRY_Z_MIN + STAIR_Z_MIN) / 2], [0.4, 1.0, STAIR_Z_MIN - GANTRY_Z_MIN], 'darkMetal', 'metal'),
  );
  // Stair-channel side rails: flank the six treads from the deck edge to the
  // lowest tread's east face, their inner faces flush with the tread edges, so a
  // walker is funneled up the climb instead of sliding off the open north/south
  // ends onto the floor. Floor-to-deck height; 'wall-' prefix so they read as
  // architecture and drop out of the contact-shadow pass like the bay walls.
  const stairXEast = GANTRY_X_MAX + STAIR_TREAD * STAIR_STEP_COUNT; // -1.0, lowest tread east face
  const stairXMid = (GANTRY_X_MAX + stairXEast) / 2;
  const stairXSpan = stairXEast - GANTRY_X_MAX;
  push(
    onFloor('wall-stair-n', [stairXMid, STAIR_Z_MIN - 0.2], [stairXSpan, 0.4], GANTRY_TOP, 'darkMetal', 'metal'),
    onFloor('wall-stair-s', [stairXMid, STAIR_Z_MAX + 0.2], [stairXSpan, 0.4], GANTRY_TOP, 'darkMetal', 'metal'),
  );

  // ── Final shutdown objective: a control console ON the gantry ────────────
  // Waist-high cover a defender holds behind, and the arena's focal point — the
  // "last light" to switch off. Base sits on the deck top; the cool beacon on it
  // is the render-only accent that plays against the warm furnace.
  const consoleXZ: readonly [number, number] = [-9.0, -12.8];
  const consoleH = 0.95;
  push(box(
    'console-obj',
    [consoleXZ[0], GANTRY_TOP + consoleH / 2, consoleXZ[1]],
    [2.4, consoleH, 1.2],
    'galvanized',
    'metal',
  ));

  // ── West-lane and furnace-apron cover ────────────────────────────────────
  push(
    onFloor('ingot-stack', [10.2, -5.4], [2.0, 2.6], 1.1, 'rust', 'metal'),
    onFloor('mould-w', [-9.8, -3.6], [1.8, 1.8], 1.3, 'darkMetal', 'metal'),
  );

  // ── Spawn-end cover (south): crates + a low barrier at the lane mouth ────
  push(
    onFloor('crate-s1', [-6.5, 2.4], [1.3, 1.3], 1.3, 'wood', 'wood'),
    onFloor('crate-s2', [2.0, 1.6], [1.4, 1.4], 1.4, 'wood', 'wood'),
    onFloor('jersey-s', [1.0, 0.2], [2.4, 0.7], 1.05, 'concrete', 'concrete'),
  );

  // ── Render-only dressing (never cover) ───────────────────────────────────
  // The hood is structural dark metal, not one giant emissive plane. Heat comes
  // from a narrow tap and point lights under that mass, so the fixture reads as
  // attached industrial hardware rather than a floating fullbright slab.
  push(
    box('furnace-tap', [3.0, 1.15, -10.8], [0.42, 1.25, 0.18], 'lampWarm', 'metal', { collide: false, castShadow: false }),
    box('furnace-hood', [7.0, 4.2, -13.5], [7.0, 0.5, 4.0], 'darkMetal', 'metal', { collide: false }),
    box('lamp-w-housing', [X_MIN + 0.3, 3.0, -6.0], [0.58, 0.42, 0.78], 'darkMetal', 'metal', { collide: false }),
    box('lamp-w', [X_MIN + 0.58, 3.0, -6.0], [0.16, 0.14, 0.34], 'lampWarm', 'metal', { collide: false, castShadow: false }),
    box('beacon', [consoleXZ[0], GANTRY_TOP + consoleH + 0.35, consoleXZ[1]], [0.42, 0.7, 0.42], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('beacon-cap', [consoleXZ[0], GANTRY_TOP + consoleH + 0.74, consoleXZ[1]], [0.54, 0.12, 0.54], 'darkMetal', 'metal', { collide: false, castShadow: false }),
  );
  // Painted hazard bands — flush on the floor, pure colour to guide the eye up
  // the casting lane and onto the stair.
  push(
    box('paint-lane', [0.0, 0.011, -4.0], [1.6, 0.02, 12.0], 'safety', 'concrete', { collide: false, castShadow: false, receiveShadow: false }),
    box('paint-stair', [-1.0, 0.011, stairZCenter], [0.5, 0.02, stairWidthZ], 'safety', 'concrete', { collide: false, castShadow: false, receiveShadow: false }),
  );

  // ── Lighting: intense warm furnace vs cool ambient ───────────────────────
  // The directional key matches the shared render pipeline's fixed IBL sun
  // (-8,14,6) so highlights agree with cast shadows. The FURNACE end is a bank
  // of hot sodium/orange point lights; the hall floor and gantry sit in a cool
  // blue hemisphere so the warm/cool contrast reads without any bespoke shader.
  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xffe0be, intensity: 2.3, position: [-8, 14, 6], castShadow: true },
    { kind: 'hemisphere', color: 0x6f8ec2, groundColor: 0x241a12, intensity: 0.55 },
    // Furnace heat: three warm pools clustered at the north-east hearth.
    { kind: 'point', color: 0xff7420, intensity: 42, position: [3.2, 1.5, -10.6], distance: 17, decay: 2 },
    { kind: 'point', color: 0xff8a2c, intensity: 30, position: [7.0, 2.6, -13.0], distance: 16, decay: 2 },
    { kind: 'point', color: 0xffb060, intensity: 22, position: [X_MIN + 0.7, 2.95, -6.0], distance: 14, decay: 2 },
    // Cold accent at the objective console on the gantry.
    { kind: 'point', color: 0x4fd6ea, intensity: 16, position: [consoleXZ[0], GANTRY_TOP + 1.4, consoleXZ[1]], distance: 9, decay: 2 },
  ];

  // ── Camera shots (evidence hooks) ────────────────────────────────────────
  const shots: ShotSpec[] = [
    {
      name: 'furnace_contrast', position: [-5.5, 1.7, 2.0], lookAt: [6.0, 1.8, -13.5],
      caption: 'Warm furnace hall vs cool ambient: the hot hearth and tap stream at the north-east against the blue-hour hall, the cool objective beacon glinting on the far gantry.',
    },
    {
      name: 'casting_lane', position: [-0.6, 1.62, 3.4], lookAt: [-0.9, 1.3, -12.0],
      caption: 'Up the casting lane from spawn: ingot moulds and a ladle car give the crouch-and-peek rhythm, heavy press plinths wall the flanks, the hazard band leads to the gantry stair.',
    },
    {
      name: 'gantry_traversal', position: [-0.2, 1.62, -8.4], lookAt: [-6.0, 1.7, -11.2],
      caption: 'The control-gantry access stair: six 0.283 m treads (each rise < the 0.34 m motor step limit) climbing west onto the deck through the parapet doorway. foundry-route.report.json proves the shipping PlayerMotor walks floor → lane → stair → console.',
    },
    {
      name: 'final_objective', position: [-5.6, 2.5, -11.0], lookAt: [-9.0, 2.1, -12.8],
      caption: 'The defended final shutdown objective: the control console on the gantry with its cool "last light" beacon, held from behind the waist-high console and the parapet.',
    },
    {
      name: 'silhouette', position: [11.4, 2.6, 3.6], lookAt: [-7.0, 2.0, -13.0],
      caption: 'Wide diagonal: the whole silhouette — furnace stack and hood, stepped machine plinths, the raised control gantry with the objective, warm heat against the cool hall.',
    },
    {
      name: 'materials', position: [4.8, 1.35, -7.6], lookAt: [6.6, 1.4, -2.6],
      caption: 'Close on a press plinth and ram head: procedural concrete/painted-metal variation catching the furnace glow and the IBL.',
    },
  ];

  // ── Two feet-based player spawns (two-slot co-op later) ──────────────────
  const playerSpawns: readonly [Vec3, Vec3] = [
    [-4.0, 0, 3.2], // slot 0 — west of the bay door, nearer the gantry side
    [4.0, 0, 3.2], //  slot 1 — east of the bay door, nearer the furnace side
  ];

  // Deterministic route the shipping-motor proof drives, derived from the
  // geometry above: spawn → lane spine → stair base → gantry landing → console.
  const routeWaypoints: readonly Vec3[] = [
    playerSpawns[0],
    [-1.0, 0, -1.5], // into the reserved west-of-centre lane corridor
    [-0.7, 0, -6.5], // north up the lane, east of the plinths
    [-0.6, 0, stairZCenter], // stair base, just east of the lowest tread
    [-2.5, GANTRY_TOP / 2, stairZCenter], // mid-climb, holds the steer due-west up the treads
    [GANTRY_X_MAX - 0.7, GANTRY_TOP, stairZCenter], // landed on the gantry
    [consoleXZ[0] + 1.9, GANTRY_TOP, consoleXZ[1]], // in front of the console
  ];

  const finalObjective: FinalObjective = {
    id: 'console-obj',
    kind: 'shutdown',
    location: [consoleXZ[0], GANTRY_TOP + consoleH, consoleXZ[1]],
    footprint: [1.6, 1.0],
    gantryDeckId: 'gantry-deck',
    standHeight: GANTRY_TOP,
    label: 'SHUT DOWN THE FOUNDRY',
    detail: 'Reach the control gantry and hold the shutdown console.',
  };

  return {
    solids,
    lights,
    shots,
    playerSpawn: playerSpawns[0],
    enemySpawn: [1.0, 0, -9.5], // defending the objective from the furnace apron / stair mouth
    enemyCoverIds: [
      'plinth-e2',
      'ladle-car',
      'furnace-buttress',
      'console-obj',
      'parapet-s',
    ],
    fog: { color: 0x1d2733, density: 0.024 },
    mission: 'foundry-last-light',
    playerSpawns,
    finalObjective,
    routeWaypoints,
  };
}
