/**
 * Deck-traversal harness (issue #43, parent #32, level #35, motor #42).
 *
 * The correspondence proof shows the rendered geometry and the collision boxes
 * agree — but an independent review found they agreed on geometry a player
 * cannot reach: the original staircase descended the wrong way and the south
 * parapet walled off the top. A proof that render == collision says nothing
 * about whether a HUMAN can climb it.
 *
 * This harness closes that gap with the only witness that counts: the SHIPPING
 * player motor. It builds the arena's REAL `StaticWorld` (the exact boxes the
 * game collides against, from `buildStaticWorld`), wraps it in the shipping
 * `StaticBoxWorld` solver and drives the shipping `PlayerMotor` (both from the
 * player subsystem, PR #40) at the engine's 120 Hz fixed step. It starts the
 * capsule ON THE FLOOR south of the stairs, walks it NORTH with ordinary WASD
 * intent — no teleport, no `motor.position =`, no free camera — and records
 * whether the feet finish standing on the deck.
 *
 * Every target is derived from the arena geometry itself (the `deck` and
 * `step-*` solids), so this fixture cannot silently drift from a layout change:
 * move the deck and the assertions move with it.
 *
 * The result is published on `window.__DECK_TRAVERSAL__` for the playwright
 * runner (`run-deck-traversal.mjs`) to assert on and archive.
 *
 * This is a `.mjs` on purpose: it is runtime test glue, not part of the typed
 * build (the repo's `tsconfig` has `allowJs` off, so `.mjs` files are excluded
 * from `tsc`). That is what lets the committed level subsystem keep
 * `tsc --noEmit` clean without vendoring the player subsystem (PR #40), which it
 * imports below only at run time. Vite transforms the imported `.ts` modules.
 */

import * as THREE from 'three';
import { buildArena } from '../arena.js';
import { buildStaticWorld } from '../staticWorld.js';
// Narrowly scoped test imports of the SHIPPING motor + solver (PR #40). These
// resolve only in an integrated tree where `src/player/` is present.
import { PlayerMotor } from '../../player/PlayerMotor.js';
import { StaticBoxWorld } from '../../player/StaticBoxWorld.js';
import { DEFAULT_PLAYER_TUNING } from '../../player/config.js';

const out = window;

const STEP = 1 / 120;
const round = (v, d = 4) => {
  const s = 10 ** d;
  return Math.round(v * s) / s;
};

try {
  const def = buildArena();
  const world = buildStaticWorld(def);
  const solver = StaticBoxWorld.fromStaticWorld(world);
  const tuning = DEFAULT_PLAYER_TUNING;

  // ── Targets derived from the REAL arena geometry (no hard-coded copy) ──────
  const deck = def.solids.find((s) => s.id === 'deck');
  const steps = def.solids.filter((s) => s.id.startsWith('step-'));
  if (!deck) throw new Error('arena has no `deck` solid to traverse to');
  if (steps.length === 0) throw new Error('arena has no `step-*` solids');

  const deckTop = deck.max[1];
  const deckXmin = deck.min[0];
  const deckXmax = deck.max[0];
  const deckZmin = deck.min[2];
  const deckZmax = deck.max[2]; // south (spawn-facing) edge
  // Past the south parapet's depth (0.4 m) with margin: proves the capsule
  // entered the deck interior, not merely perched on the top tread.
  const deckInteriorZ = deckZmax - 0.6;

  const stairXCenter = (Math.min(...steps.map((s) => s.min[0]))
    + Math.max(...steps.map((s) => s.max[0]))) / 2;
  const stairSouthZ = Math.max(...steps.map((s) => s.max[2])); // southmost tread face
  const spawnZ = stairSouthZ + 2.0; // start 2 m south of the first riser, on the floor

  const spawn = new THREE.Vector3(stairXCenter, 0, spawnZ);
  if (!solver.canFit(spawn, tuning.standingHeight, tuning.radius)) {
    throw new Error(`spawn ${spawn.toArray().join(',')} does not fit the capsule`);
  }

  const motor = new PlayerMotor(solver, spawn, tuning);

  // ── Drive: hold "forward" (north) until on the deck, then release to settle ─
  const yaw = 0; // forward = (-sin, 0, -cos) = (0,0,-1) → +north (−Z)
  const MAX_TICKS = 1400;
  const trajectory = [];

  let reachedDeck = false;
  let reachedDeckTick = -1;
  let maxSteppedHeight = 0;
  let maxSingleTickRiseMm = 0;
  let airborneClimbTicks = 0;
  let minFeetY = spawn.y;
  let prevY = spawn.y;

  for (let t = 0; t < MAX_TICKS; t++) {
    const moveY = reachedDeck ? 0 : 1;
    const result = motor.fixedUpdate(STEP, {
      moveX: 0, moveY, yaw, jumpPressed: false, crouch: false, sprint: false,
    });
    const p = motor.position;

    maxSteppedHeight = Math.max(maxSteppedHeight, result.steppedHeight);
    const dyMm = (p.y - prevY) * 1000;
    if (dyMm > maxSingleTickRiseMm) maxSingleTickRiseMm = dyMm;
    if (p.y < minFeetY) minFeetY = p.y;
    // Airborne while climbing (left the floor, not yet on the deck) is a real
    // defect — a walker should never free-fall between treads.
    if (!reachedDeck && !motor.grounded && p.y > 0.05) airborneClimbTicks += 1;

    trajectory.push({
      t, x: round(p.x), y: round(p.y), z: round(p.z),
      grounded: motor.grounded, stepped: round(result.steppedHeight),
    });

    if (
      !reachedDeck
      && motor.grounded
      && p.z <= deckInteriorZ
      && Math.abs(p.y - deckTop) < 0.06
    ) {
      reachedDeck = true;
      reachedDeckTick = t;
    }
    if (reachedDeck) {
      const hSpeed = Math.hypot(motor.velocity.x, motor.velocity.z);
      if (hSpeed < 0.03) break; // settled on the deck
    }
    prevY = p.y;
  }

  const final = trajectory[trajectory.length - 1];
  const start = trajectory[0];
  const onDeckFootprint = final.x > deckXmin && final.x < deckXmax
    && final.z < deckZmax && final.z > deckZmin;

  const assertions = [
    {
      name: 'started_on_floor',
      passed: Math.abs(start.y) < 0.02 && trajectory.slice(0, 3).some((s) => s.grounded),
      actual: { startFeetY: start.y, grounded: start.grounded },
      expected: 'feet at y≈0, grounded (began standing on the floor, not placed on the deck)',
    },
    {
      name: 'climb_stays_grounded',
      passed: airborneClimbTicks === 0,
      actual: { airborneClimbTicks },
      expected: '0 airborne ticks during the climb (no free-fall between treads)',
    },
    {
      name: 'step_up_within_motor_limit',
      passed: maxSteppedHeight <= tuning.maxStepHeight + 1e-3,
      actual: { maxSteppedHeightM: round(maxSteppedHeight, 5), maxStepHeightM: tuning.maxStepHeight },
      expected: `every step-up ≤ maxStepHeight (${tuning.maxStepHeight} m)`,
    },
    {
      name: 'reached_deck',
      passed: reachedDeck,
      actual: { reachedDeck, reachedDeckTick },
      expected: 'a grounded tick at deck height, past the south parapet',
    },
    {
      name: 'finished_standing_on_deck',
      passed: final.grounded
        && Math.abs(final.y - deckTop) < 0.05
        && onDeckFootprint
        && final.z <= deckZmax - 0.4,
      actual: {
        grounded: final.grounded, feetY: final.y, x: final.x, z: final.z,
        deckTop, onDeckFootprint,
      },
      expected: `grounded, feetY≈${deckTop} m, inside the deck footprint and north of the parapet`,
    },
  ];

  const ok = assertions.every((a) => a.passed);

  out.__DECK_TRAVERSAL__ = {
    at: new Date().toISOString(),
    ok,
    fixedStepHz: 1 / STEP,
    motor: 'shipping PlayerMotor + StaticBoxWorld (src/player, PR #40)',
    world: {
      source: 'buildStaticWorld(buildArena()) — the exact shipped collision',
      boxes: world.boxes.length,
    },
    derivedTargets: {
      deckTop, deckXmin, deckXmax, deckZmin, deckZmax, deckInteriorZ,
      stairXCenter: round(stairXCenter), stairSouthZ: round(stairSouthZ),
      spawn: spawn.toArray().map((v) => round(v)),
    },
    tuning: {
      radius: tuning.radius,
      standingHeight: tuning.standingHeight,
      walkSpeed: tuning.walkSpeed,
      gravity: tuning.gravity,
      maxStepHeight: tuning.maxStepHeight,
      groundSnapDistance: tuning.groundSnapDistance,
    },
    metrics: {
      ticks: trajectory.length,
      reachedDeckTick,
      maxSteppedHeightM: round(maxSteppedHeight, 5),
      maxSingleTickRiseMm: round(maxSingleTickRiseMm, 1),
      airborneClimbTicks,
      minFeetY: round(minFeetY, 5),
      final,
    },
    assertions,
    trajectory,
  };
  out.__FRAME_READY__ = true;
} catch (err) {
  out.__DECK_TRAVERSAL_ERROR__ = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  out.__FRAME_READY__ = true;
}
