/**
 * Mission 2 — RELAY BLACKOUT.
 *
 * A second, structurally distinct arena for the vertical slice, authored to the
 * SAME one-source-of-truth discipline as the cargo bay (`../../arena.ts`): every
 * piece of geometry AND collision is a single `Solid` record, axis-aligned only,
 * from which both the render mesh (`../../geometry.ts`) and the `StaticBox`
 * collision (`../../staticWorld.ts`) are derived, and against which
 * `../../correspondence.ts` proves render ⇄ collision agreement. Restricting the
 * world to axis-aligned boxes keeps the player motor's unverified slope path
 * unreachable (issue #32), exactly as the cargo arena does.
 *
 * This file imports the shared level contracts and reuses the shared procedural
 * material library by material KEY only — it invents no new `three` material and
 * downloads no asset, so it inherits the CC0/original licence posture. The mood
 * ("rain-blue electrical relay complex") is carried by LIGHTING and layout, not
 * by a recolour of the cargo palette; the `container` vertex-tint material that
 * is the cargo bay's signature is deliberately NOT used here, which also keeps
 * the shared container-dressing selector empty for this arena.
 *
 * It is pure: it returns data only — no `three`, no DOM — so the correspondence
 * proof, the topology fingerprint and the traversal fixture can all rebuild the
 * exact world in Node/headless without a renderer.
 *
 * Scale & shape (deliberately unlike cargo's 24×21 deep bay): a WIDE, shallow
 * switchyard, ~28 m × 22 m, entered from the south between two staggered banks of
 * transformers, with a CENTRAL six-step access to a north control deck that
 * carries the relay objective. Cargo raises an EAST overwatch deck as a flanking
 * position and holds its objective on the floor; here the raised deck IS the
 * objective, reached head-on up a central stair. Different bounds, different id
 * set, different route graph, different sightlines — proven distinct by the
 * committed `topology.ts` comparison, not asserted.
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

// ── Mission-level metadata (extends, does not replace, ArenaDefinition) ──────

/** The relay objective: an id (matching the cover `Solid`), a label, and the
 *  standing point on the control deck a player holds to work it. */
export interface RelayObjective {
  readonly id: string;
  readonly label: string;
  /** Feet position of the hold point on the control deck. */
  readonly position: Vec3;
}

/** One co-op deploy slot: a feet position and a human-readable name. */
export interface RelaySpawnSlot {
  readonly name: string;
  readonly position: Vec3;
}

/**
 * The declared, testable initial-sightline policy. Endpoints are derived from
 * the arena (spawns / enemy / objective) so the LOS fixture measures the real
 * geometry against these expectations rather than a hand-copied guess — a leak
 * or an accidental sightline fails the fixture.
 */
export interface RelayLosPolicy {
  readonly name: string;
  readonly statement: string;
  /** Eye height used for every probe; mirrors PlayerTuning.standingEyeHeight. */
  readonly eyeHeight: number;
  readonly expect: {
    readonly enemyToSpawnA: 'blocked' | 'clear';
    readonly enemyToSpawnB: 'blocked' | 'clear';
    readonly spawnAToSpawnB: 'blocked' | 'clear';
    readonly spawnAToObjective: 'blocked' | 'clear';
    readonly spawnBToObjective: 'blocked' | 'clear';
    readonly enemyToObjective: 'blocked' | 'clear';
  };
}

export interface RelayMissionMeta {
  readonly id: 'relay-blackout';
  readonly index: 2;
  readonly codename: string;
  readonly name: string;
  readonly biome: string;
  readonly synopsis: string;
  /** Enemy count in the shipped compact slice. */
  readonly enemyCount: number;
  /** Player capacity: the slice ships one, but two deploy slots exist for co-op. */
  readonly players: { readonly now: number; readonly max: number };
}

/**
 * A superset of `ArenaDefinition`: assignable anywhere an `ArenaDefinition` is
 * expected (so `buildStaticWorld`, `mergeSolidsByMaterial`, `checkCorrespondence`
 * and `ArenaLevel` all consume it unchanged), plus the extra mission metadata the
 * base contract has no field for — two spawns, the objective, the LOS policy.
 * `playerSpawn` is set to `playerSpawns[0]` so the base contract stays valid.
 */
export interface RelayArenaDefinition extends ArenaDefinition {
  readonly mission: RelayMissionMeta;
  /** Two co-op deploy slots. `playerSpawn` equals `playerSpawns[0].position`. */
  readonly playerSpawns: readonly [RelaySpawnSlot, RelaySpawnSlot];
  readonly objective: RelayObjective;
  readonly los: RelayLosPolicy;
}

// ── Authoring helpers (local, mirroring ../../arena.ts) ───────────────────────

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

/** A box sitting ON the floor: base at y=0, height grows upward. */
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

// ── Layout constants ─────────────────────────────────────────────────────────
// Interior play area, bounded by the inner faces of the four walls. Wider and
// shallower than the cargo bay so the bounds fingerprint differs by construction.
const X_MIN = -14;
const X_MAX = 14;
const Z_MIN = -18; // far (north) wall inner face — the control-deck / relay end
const Z_MAX = 4; //   near (south) wall inner face — the switchyard entry
const WALL_T = 0.6;
const FLOOR_DROP = 0.6;

// Control deck.
const DECK_TOP = 1.6; // raised deck height, matched to the 6×0.267 m stair below
const DECK_X_MIN = -4.5;
const DECK_X_MAX = 4.5;
const DECK_Z_SOUTH = -12.5; // south (spawn-facing) edge of the deck
const DECK_Z_NORTH = Z_MIN; // deck runs back to the north wall

// Central access stair.
const STAIR_X_CENTER = 0;
const STAIR_WIDTH = 2.4; // x ∈ [-1.2, 1.2]
const STEP_COUNT = 6;
const STEP_RISE = DECK_TOP / STEP_COUNT; // 0.2667 m < motor maxStepHeight 0.34 m
const STEP_TREAD = 0.5; // tread depth in Z

// The two co-op deploy pads, each screened behind a south transformer bank.
const SPAWN_A: Vec3 = [-4.2, 0, 0.9];
const SPAWN_B: Vec3 = [4.2, 0, 0.9];
const ENEMY_SPAWN: Vec3 = [3.4, 0, -9.8]; // floor-level relay defender, south of e2
const OBJECTIVE_HOLD: Vec3 = [0, DECK_TOP, -14.0]; // on the deck, in front of the relay cabinet

// Standing eye height, mirrored from player/config.ts DEFAULT_PLAYER_TUNING so
// the LOS probes are measured at the height a shipped player actually sees from.
// The topology fixture asserts this equals the real tuning value.
const STANDING_EYE_HEIGHT = 1.66;

/**
 * Builds the RELAY BLACKOUT arena. Pure: data only, no `three`, no DOM. Called
 * by the mission harness, by the correspondence/lifecycle proof, by the topology
 * fingerprint and by the traversal fixture — all against this same output.
 */
export function buildRelayArena(): RelayArenaDefinition {
  const solids: Solid[] = [];
  const push = (...s: Solid[]): void => {
    for (const solid of s) solids.push(solid);
  };

  // ── Ground ──────────────────────────────────────────────────────────────
  // One slab under everything, top face at y=0, extended under the walls so the
  // perimeter has no seam.
  push(box(
    'floor',
    [(X_MIN + X_MAX) / 2, -FLOOR_DROP / 2, (Z_MIN + Z_MAX) / 2],
    [(X_MAX - X_MIN) + WALL_T * 2, FLOOR_DROP, (Z_MAX - Z_MIN) + WALL_T * 2],
    'concrete',
    'concrete',
    { castShadow: false },
  ));

  // ── Perimeter ─────────────────────────────────────────────────────────────
  // North is a tall utility-building backdrop the control deck sits against; the
  // sides are lower; the south wall is split into two piers flanking a switchyard
  // GATE the two players deploy just inside of. A distinct silhouette from
  // cargo's pier/lintel north wall and open sides.
  const span = (X_MAX - X_MIN) + WALL_T * 2;
  const northTop = 5.6;
  const sideTop = 3.6;
  const southTop = 3.2;
  push(onFloor('wall-n', [(X_MIN + X_MAX) / 2, Z_MIN - WALL_T / 2], [span, WALL_T], northTop, 'concreteDark', 'concrete'));
  push(
    onFloor('wall-w', [X_MIN - WALL_T / 2, (Z_MIN + Z_MAX) / 2], [WALL_T, (Z_MAX - Z_MIN)], sideTop, 'concrete', 'concrete'),
    onFloor('wall-e', [X_MAX + WALL_T / 2, (Z_MIN + Z_MAX) / 2], [WALL_T, (Z_MAX - Z_MIN)], sideTop, 'concrete', 'concrete'),
  );
  // South gate: two piers + an overhead gantry lintel over the opening.
  const gateW = 4.0;
  const southPierW = (span - gateW) / 2;
  push(
    onFloor('wall-s-west', [X_MIN - WALL_T / 2 + southPierW / 2, Z_MAX + WALL_T / 2], [southPierW, WALL_T], southTop, 'concrete', 'concrete'),
    onFloor('wall-s-east', [X_MAX + WALL_T / 2 - southPierW / 2, Z_MAX + WALL_T / 2], [southPierW, WALL_T], southTop, 'concrete', 'concrete'),
    box('wall-s-gantry', [(X_MIN + X_MAX) / 2, 3.4, Z_MAX + WALL_T / 2], [gateW, 1.4, WALL_T], 'darkMetal', 'metal'),
  );

  // ── Control deck (north-centre) ──────────────────────────────────────────
  // A raised galvanised platform against the north wall, top at DECK_TOP. Reached
  // head-on by the central stair; carries the relay objective. Cargo's deck is on
  // the EAST wall and holds no objective — this one is the mission's focal hold.
  push(box(
    'deck',
    [(DECK_X_MIN + DECK_X_MAX) / 2, DECK_TOP - 0.2, (DECK_Z_NORTH + DECK_Z_SOUTH) / 2],
    [DECK_X_MAX - DECK_X_MIN, 0.4, DECK_Z_SOUTH - DECK_Z_NORTH],
    'galvanized',
    'metal',
  ));

  // Six ascending treads climbing NORTH onto the deck. i=0 is the TOP tread,
  // flush with the deck top and contiguous with its south edge; each tread
  // further south is one STEP_RISE lower, and the tallest equals the deck height
  // so the final move onto the deck is flat, not a wall. Every northward rise is
  // STEP_RISE = 0.267 m < the motor's 0.34 m step limit — the traversal fixture
  // drives the shipping motor up these exact boxes.
  for (let i = 0; i < STEP_COUNT; i++) {
    const h = DECK_TOP - STEP_RISE * i;
    const zCenter = DECK_Z_SOUTH + STEP_TREAD * i + STEP_TREAD / 2;
    push(onFloor(`step-${i}`, [STAIR_X_CENTER, zCenter], [STAIR_WIDTH, STEP_TREAD], h, 'galvanized', 'metal'));
  }

  // Deck parapets 1.0 m above the deck (chest-high when standing on it): west and
  // east edges, and a SOUTH edge SPLIT to leave a doorway over the stair so the
  // climb lands on the deck rather than walling it off (the #43 lesson). North is
  // the building wall, so it needs no rail.
  const gapXMin = STAIR_X_CENTER - STAIR_WIDTH / 2; // -1.2
  const gapXMax = STAIR_X_CENTER + STAIR_WIDTH / 2 + 0.3; // 1.5 (east clearance)
  push(
    box('parapet-w', [DECK_X_MIN + 0.2, DECK_TOP + 0.5, (DECK_Z_NORTH + (DECK_Z_SOUTH - 0.4)) / 2], [0.4, 1.0, (DECK_Z_SOUTH - 0.4) - DECK_Z_NORTH], 'darkMetal', 'metal'),
    box('parapet-e', [DECK_X_MAX - 0.2, DECK_TOP + 0.5, (DECK_Z_NORTH + (DECK_Z_SOUTH - 0.4)) / 2], [0.4, 1.0, (DECK_Z_SOUTH - 0.4) - DECK_Z_NORTH], 'darkMetal', 'metal'),
    box('parapet-s-w', [(DECK_X_MIN + gapXMin) / 2, DECK_TOP + 0.5, DECK_Z_SOUTH - 0.2], [gapXMin - DECK_X_MIN, 1.0, 0.4], 'darkMetal', 'metal'),
    box('parapet-s-e', [(gapXMax + DECK_X_MAX) / 2, DECK_TOP + 0.5, DECK_Z_SOUTH - 0.2], [DECK_X_MAX - gapXMax, 1.0, 0.4], 'darkMetal', 'metal'),
  );

  // The relay objective: a tall control cabinet on the deck, near the north wall.
  // Standing cover the defender holds behind; the mission's focal point.
  push(box('relay-core', [0, DECK_TOP + 0.65, -15.3], [2.4, 1.3, 1.0], 'darkMetal', 'metal'));

  // ── Staggered transformer aisles ──────────────────────────────────────────
  // The signature layout: two columns of tall transformer tanks (x ≈ ±4.2)
  // forming a west lane, an open central approach and an east lane. A near gate
  // pair (w1/e1) stands just north of the deploy pads and a staggered rear guard
  // (w2/e2) flanks the relay stair. Each pad sits directly north-blocked by its
  // near transformer, so a player's straight-ahead WALKING line is blocked and
  // they must commit to a lane (cargo forces the same left/right choice with a
  // stacked container cluster — a different silhouette and tactical shape). The
  // near pair is deep enough in front of each pad that it also SCREENS the pad's
  // rising diagonal to the raised relay: the objective is a fought-for hold, not
  // a spawn-visible target (measured symmetrically by the LOS fixture). Standing
  // eye height is 1.66 m, so these 2.3–2.5 m tanks are true sightline blockers;
  // the low cover below is crouch-and-peek only.
  push(
    onFloor('transformer-w1', [-4.2, -3.2], [2.8, 2.2], 2.5, 'rust', 'metal'),
    onFloor('transformer-e1', [4.2, -3.7], [2.8, 2.2], 2.5, 'galvanized', 'metal'),
    onFloor('transformer-w2', [-4.2, -9.4], [2.6, 2.2], 2.5, 'galvanized', 'metal'),
    onFloor('transformer-e2', [4.2, -11.6], [2.4, 2.0], 2.3, 'rust', 'metal'),
  );

  // A central switch-house that screens the diagonal from the north-east enemy
  // hold to the WEST pad (measured, not eyeballed — see the LOS fixture); waist-
  // high-plus at 1.9 m so it blocks standing sightlines, and offset so it never
  // walls the central approach: the deterministic route weaves through the ~1.3 m
  // throat on either side (between this house and the near transformer gate) —
  // the traversal fixture drives the shipping motor through both throats.
  push(onFloor('switchhouse', [0, -5.2], [3.0, 1.6], 1.9, 'concreteDark', 'concrete'));

  // ── Lane cover: low relay cabinets, cable reels, a drum ───────────────────
  // Chest-high concrete (1.1 m) and wooden cable reels (1.4 m) give the crouch-
  // and-peek rhythm; a steel drum sits at the stair base. None of these reaches
  // standing eye height, so they shape the fight without screening it.
  push(
    onFloor('cabinet-w', [-8.6, -3.0], [2.2, 0.8], 1.1, 'concrete', 'concrete'),
    onFloor('cabinet-e', [8.6, -4.6], [2.2, 0.8], 1.1, 'concreteDark', 'concrete'),
    onFloor('breaker-w', [-8.9, -8.6], [1.8, 1.2], 1.6, 'darkMetal', 'metal'),
    onFloor('reel-e', [9.2, -8.4], [1.4, 1.4], 1.4, 'wood', 'wood'),
    onFloor('reel-w', [-6.4, -12.6], [1.4, 1.4], 1.4, 'wood', 'wood'),
    onFloor('drum-n', [1.7, -10.4], [0.8, 0.8], 1.0, 'rust', 'metal'),
    onFloor('relaybox-e', [9.0, -12.8], [1.6, 1.0], 1.2, 'darkMetal', 'metal'),
  );

  // ── Render-only dressing (never cover) ────────────────────────────────────
  // Transformer bushings: small caps on the tanks so their silhouette reads as
  // electrical plant rather than plain crates. Non-collide; up out of reach.
  push(
    box('bushing-w1', [-4.2, 2.5 + 0.2, -3.2], [1.6, 0.4, 1.2], 'galvanized', 'metal', { collide: false }),
    box('bushing-e1', [4.2, 2.5 + 0.2, -3.7], [1.6, 0.4, 1.2], 'galvanized', 'metal', { collide: false }),
    box('bushing-w2', [-4.2, 2.5 + 0.2, -9.4], [1.6, 0.4, 1.2], 'galvanized', 'metal', { collide: false }),
    box('bushing-e2', [4.2, 2.3 + 0.2, -11.6], [1.4, 0.4, 1.0], 'galvanized', 'metal', { collide: false }),
  );
  // Overhead cable trays / bus ducts spanning the switchyard — high dressing that
  // frames the space; never body-height, so honestly non-collide.
  push(
    box('bus-duct-w', [-4.2, 4.4, -8.0], [0.5, 0.3, 8.0], 'darkMetal', 'metal', { collide: false, receiveShadow: false }),
    box('bus-duct-e', [4.2, 4.4, -8.0], [0.5, 0.3, 8.0], 'darkMetal', 'metal', { collide: false, receiveShadow: false }),
  );
  // The relay status beacon on top of the objective cabinet — the cool accent
  // that draws the eye to the hold and gives bloom a cold source (a "blackout"
  // emergency light). Plus a dark cap so it reads as a housing, not a floating
  // glow.
  push(
    box('relay-beacon', [0, DECK_TOP + 1.3 + 0.35, -15.3], [0.4, 0.7, 0.4], 'beacon', 'metal', { collide: false, castShadow: false }),
    box('relay-beacon-cap', [0, DECK_TOP + 1.3 + 0.74, -15.3], [0.52, 0.1, 0.52], 'darkMetal', 'metal', { collide: false, castShadow: false }),
  );
  // Cable-trench dressing: flush dark grate strips running north down the aisles,
  // and hazard bands — an arc-flash boundary at the stair base and a threshold at
  // the gate. Pure flat colour on the floor, no relief (AABB / no slope), so they
  // dress the ground without ever being mistaken for a step.
  push(
    box('trench-w', [-4.2, 0.012, -6.5], [0.8, 0.02, 11.0], 'darkMetal', 'metal', { collide: false, castShadow: false, receiveShadow: false }),
    box('trench-e', [4.2, 0.012, -7.5], [0.8, 0.02, 9.0], 'darkMetal', 'metal', { collide: false, castShadow: false, receiveShadow: false }),
    box('trench-c', [0, 0.012, -8.0], [0.6, 0.02, 8.0], 'darkMetal', 'metal', { collide: false, castShadow: false, receiveShadow: false }),
    box('paint-arcflash', [0, 0.014, -9.2], [STAIR_WIDTH + 1.2, 0.02, 0.4], 'safety', 'concrete', { collide: false, castShadow: false, receiveShadow: false }),
    box('paint-threshold', [0, 0.014, 1.6], [gateW, 0.02, 0.4], 'safety', 'concrete', { collide: false, castShadow: false, receiveShadow: false }),
  );
  // Warm sodium security lamp at the entry (contrast against the cold interior)
  // and a cool relay practical over the deck.
  push(
    box('lamp-entry', [X_MIN + 0.35, 3.0, 1.0], [0.5, 0.32, 0.7], 'lampWarm', 'metal', { collide: false, castShadow: false }),
    box('lamp-deck', [X_MAX - 0.35, 3.0, -14.0], [0.5, 0.32, 0.7], 'beacon', 'metal', { collide: false, castShadow: false }),
  );

  // ── Lighting: rain-blue blue-hour, cold relay practicals, one warm entry ──
  // The directional key is aligned to the render pipeline's IBL sun direction
  // (-8,14,6) so the metal highlights agree with the shadows — the same
  // coherence the ProceduralSky/RenderSystem were built around — but cooled to a
  // rainy blue rather than cargo's warm dusk.
  const lights: LightSpec[] = [
    { kind: 'directional', color: 0xbcd0ff, intensity: 2.35, position: [-8, 14, 6], castShadow: true },
    { kind: 'hemisphere', color: 0x6f8bc4, groundColor: 0x1b222b, intensity: 0.66 },
    // Cold cyan relay practicals: over the control deck / relay, and a mid pool.
    { kind: 'point', color: 0x4fd6ea, intensity: 26, position: [0, 3.2, -14.2], distance: 15, decay: 2 },
    { kind: 'point', color: 0x58c8e6, intensity: 18, position: [X_MAX - 0.7, 2.95, -14.0], distance: 13, decay: 2 },
    { kind: 'point', color: 0x6ec3e0, intensity: 16, position: [-6.0, 3.0, -7.5], distance: 12, decay: 2 },
    // One warm sodium security lamp at the south entry, for colour contrast.
    { kind: 'point', color: 0xff9a44, intensity: 20, position: [X_MIN + 0.7, 2.95, 1.0], distance: 14, decay: 2 },
  ];

  // ── Camera shots (evidence hooks) ─────────────────────────────────────────
  const shots: ShotSpec[] = [
    {
      name: 'spawn', position: [4.2, 1.72, 1.2], lookAt: [0.5, 1.3, -13],
      caption: 'Opening read from the east deploy pad: the staggered transformer bank breaks the straight line north and forces a lane choice toward the central relay stair.',
    },
    {
      name: 'switchyard', position: [-7.2, 1.62, -1.4], lookAt: [-4.2, 1.45, -12.5],
      caption: 'Down the west switchyard aisle: two staggered transformer tanks and a low relay cabinet, the cable trench running north between them toward the control deck.',
    },
    {
      name: 'stairs', position: [3.4, 1.62, -7.6], lookAt: [0.2, 1.55, -13.6],
      caption: 'The central six-step access: six 0.267 m treads (each rise < the 0.34 m motor step limit) climbing north through the parapet doorway onto the control deck. The traversal fixture drives the shipping motor floor → deck up these exact boxes.',
    },
    {
      name: 'controldeck', position: [0, DECK_TOP + STANDING_EYE_HEIGHT, -13.2], lookAt: [0, 0.9, -2.0],
      caption: 'Standing eye height on the reachable control deck (deck 1.60 m + 1.66 m eye), looking back south over the switchyard — the commanding relay overwatch. The traversal fixture proves a player can stand here.',
    },
    {
      name: 'objective', position: [2.6, DECK_TOP + 1.0, -13.4], lookAt: [0, 2.1, -15.4],
      caption: 'Close on the relay objective: the control cabinet and its cold status beacon on the deck, the hold the enemy defends and the player must reach and work.',
    },
    {
      name: 'silhouette', position: [-12.6, 2.6, 2.6], lookAt: [6.0, 2.1, -14],
      caption: 'Wide diagonal: the whole rain-blue silhouette — staggered transformers, overhead bus ducts, the stepped control deck and cold relay beacon against the blue hour.',
    },
    {
      name: 'materials', position: [-2.6, 1.4, -1.8], lookAt: [-4.2, 1.4, -3.4],
      caption: 'Close on a transformer tank and the concrete floor: the shared procedural rust/galvanised/concrete library catching the cool IBL, no recolour and no new texture.',
    },
  ];

  const enemyCoverIds: readonly string[] = [
    'transformer-e2',
    'transformer-w2',
    'relay-core',
    'drum-n',
    'relaybox-e',
    'switchhouse',
  ];

  const mission: RelayMissionMeta = {
    id: 'relay-blackout',
    index: 2,
    codename: 'RELAY BLACKOUT',
    name: 'Relay Blackout',
    biome: 'rain-blue electrical relay / utility switchyard',
    synopsis:
      'A blacked-out switchyard: push from the south gate up a staggered transformer aisle, '
      + 'climb the central access stair, and take the raised control deck to restore the relay '
      + 'the lone defender is holding.',
    enemyCount: 1,
    players: { now: 1, max: 2 },
  };

  const playerSpawns: readonly [RelaySpawnSlot, RelaySpawnSlot] = [
    { name: 'deploy-west', position: SPAWN_A },
    { name: 'deploy-east', position: SPAWN_B },
  ];

  const objective: RelayObjective = {
    id: 'relay-core',
    label: 'Restore the relay',
    position: OBJECTIVE_HOLD,
  };

  const los: RelayLosPolicy = {
    name: 'screened-entry',
    statement:
      'No initial line of sight from the enemy to either player deploy pad: the staggered '
      + 'transformer banks and the central switch-house screen the switchyard entry, so two '
      + 'players deploy safely and the fight opens only as they push a lane. The two pads share '
      + 'mutual sightline for a coordinated deploy, and the relay objective is not visible from '
      + 'either pad — it is a fought-for hold, not a spawn-camp target.',
    eyeHeight: STANDING_EYE_HEIGHT,
    expect: {
      enemyToSpawnA: 'blocked',
      enemyToSpawnB: 'blocked',
      spawnAToSpawnB: 'clear',
      spawnAToObjective: 'blocked',
      spawnBToObjective: 'blocked',
      enemyToObjective: 'clear',
    },
  };

  return {
    solids,
    lights,
    shots,
    playerSpawn: SPAWN_A,
    enemySpawn: ENEMY_SPAWN,
    enemyCoverIds,
    fog: { color: 0x1b2836, density: 0.03 },
    mission,
    playerSpawns,
    objective,
    los,
  };
}
