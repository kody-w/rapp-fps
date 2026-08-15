# `src/level/fixtures` — proofs the player subsystem can trust

Two fixtures live here:

- **deck-traversal** — the answer to issue #43: can the shipping player motor
  actually walk floor→deck up the geometry correspondence proves is *there*?
- **contact-shadows** — the answer to issue #60: is the authored floor-grounding
  layer selected correctly, footprint-exact, render-only and within budget?

## Why

The arena ships a `verify-correspondence.mjs` proof that the rendered geometry
and the collision `StaticWorld` agree box-for-box. An independent review of
PR #38 found the deeper hole that proof cannot see: render and collision *agreed
on geometry a player could not reach*. The overwatch deck's staircase was
inverted (the tallest tread first, a 1.28 m rise into the deck) and the south
parapet walled off the top, so the only evidence that the deck was usable —
`overwatch.png` — was shot from a **free camera at a position no player can
stand in**.

Correspondence is necessary but not sufficient. This fixture adds the missing
witness: **can the shipping player motor actually walk there?**

## What it does

`deck-traversal.harness.mjs` (loaded by `deck-traversal.harness.html`) builds
the arena's **real** `StaticWorld` (`buildStaticWorld(buildArena())`) and drives
the **shipping `PlayerMotor` + `StaticBoxWorld`** at the engine's 120 Hz fixed
step. It:

1. spawns a capsule **on the floor** ~2 m south of the stairs (asserts it fits),
2. holds ordinary "forward" (north) WASD intent — **no teleport, no
   `motor.position =`, no free camera** — until the feet reach the deck,
3. records the trajectory and gates five assertions: started on the floor,
   stayed grounded through the climb (0 airborne ticks), every step-up ≤
   `maxStepHeight`, reached the deck, finished standing on the deck footprint
   past the parapet.

Every target (deck height, stair centre, spawn) is derived from the arena
geometry, so the fixture moves with the layout instead of drifting from it.

`run-deck-traversal.mjs` loads the harness in headless Chromium, prints the
assertion table, archives `../evidence/deck-traversal.report.json`, and exits
non-zero if the capsule did not finish standing on the deck (or if the page
logged any error).

## Pinned dependency: the player subsystem (PR #40)

The harness imports the real motor from `src/player/` — **PR #40**
(`kody-w/rapp-fps`, branch tip `5842b5a` at the time of writing). That subsystem
is **not** part of the level PR and is **not** vendored here. To run the fixture,
check the fixture out into an integrated tree where `src/player/` is present
(e.g. PR #40 merged, or its branch checked out alongside this one). The
committed level subsystem imports it only as runtime test glue.

This is why the harness is a `.mjs`, not a `.ts`: the repo `tsconfig` has
`allowJs` off, so `.mjs` files are excluded from `tsc`. That keeps
`npx tsc --noEmit` clean on this branch **without** `src/player` present, while
the fixture still binds the *real* motor at run time. (PR #40 may re-tag once for
its own try/finally correction; re-pin the SHA above if you re-baseline.)

## Run it

```sh
# 1. dev server (from the repo root)
npm exec --prefix <repo> -- vite <repo> --host 127.0.0.1 --port 5283 --strictPort

# 2. the fixture (needs src/player present)
node src/level/fixtures/run-deck-traversal.mjs \
  --url http://127.0.0.1:5283/src/level/fixtures/deck-traversal.harness.html
```

## Evidence

- `../evidence/deck-traversal.report.json` — the passing run on the shipped
  arena: 5/5, feet finish at y=1.60 m, x=7.40, z=−11.12 (deck interior, past the
  parapet), max step-up 0.267 m ≤ 0.34 m, 0 airborne ticks.
- `../evidence/deck-traversal.baseline-defect.report.json` — the **negative
  control**: the same motor against the pre-fix geometry (stairs temporarily
  reverted) is blocked at the base of the 1.60 m first tread and never reaches
  the deck (2 assertions FAIL). Proof the fixture fails on the defect it guards,
  rather than passing vacuously.

---

# contact-shadows (#60)

## Why

With `N8AO` off (it breaks the 16.7 ms budget), the shipped lighting darkens the
floor under cover so little that a direct on/off framebuffer diff moves 0.77 % of
pixels at mean 0.154/255 — visually nothing — so the crates and jersey barriers
read as floating. `contactShadows.ts` authors the missing grounding cue as one
`InstancedMesh` of soft, footprint-sized floor marks. This fixture proves that
layer is honest: correctly *selected*, footprint-*exact*, *render-only*, and
*cheap* — the four ways an authored cheat like this could quietly go wrong.

## What it does

`contact-shadows.harness.mjs` (loaded by `contact-shadows.harness.html`) builds
the **real** layer from the shipped modules (`selectGroundContactSolids`,
`createContactShadowLayer`) against `buildArena()` and gates 13 assertions:

1. **selection** — exactly the 10 authored floor-standing solids, no more.
2. **selected_are_floor_standing** — every selected solid is collidable and rests
   on `y=0`.
3. **footprint_exact_from_solid** — each mark's centre/size equals the solid's
   `(min+max)/2` and `(max−min)`, to the micron — no duplicated coordinates.
4. **marks_horizontal** + **y_offset_measured** — the quad normal is +Y and the
   mark sits a measured 6 mm above the floor.
5. **adds_no_collider** + **marks_not_mistaken_for_geometry** — the layer adds no
   collision box and its corner-keys never intersect a collider corner-key.
6. **correspondence_still_5_of_5** — the arena's own proof still passes with the
   layer composed.
7. **negative_control_rejected** — the floor slab, a perimeter wall, a stair
   tread, a stacked crate and the beacon are each **rejected** (an ineligible
   floor/wall/stair cannot sneak a mark).
8. **lifecycle_repeatable_clean** — build→dispose→build leaves no orphaned parent
   and disposes mesh/geometry/material.
9. **one_additional_draw** + **zero_generated_textures** — measured with two fresh
   renderers: the layer costs exactly +1 draw call and 0 generated textures.
10. **pixel_diff_meaningful_and_local** — an on/off `readPixels` diff shows the
    mark is both visible where it should be and absent everywhere else.

`run-contact-shadows.mjs` loads it in headless Chromium, prints the assertion
table + selection/resource/pixel-diff summary, archives
`../evidence/contact-shadows.report.json`, and exits non-zero on any failed
assertion or console error.

Unlike deck-traversal, this fixture needs **no** external subsystem — it binds
only `src/level` — so it runs on this branch as-is.

## Run it

```sh
npm exec --prefix <repo> -- vite <repo> --host 127.0.0.1 --port 5283 --strictPort
node src/level/fixtures/run-contact-shadows.mjs \
  --url http://127.0.0.1:5283/src/level/fixtures/contact-shadows.harness.html
```

## Evidence

- `../evidence/contact-shadows.report.json` — **13/13 PASS**, 10 marks, +1 draw /
  +0 texture; on/off pixel diff 1.15 % of pixels at mean 16.9/255 where changed
  (vs the VSM baseline 0.77 % / 0.154).
- `../evidence/contact-on/*` vs `../evidence/contact-off/*` — matched 1920×1080
  frames (`grounding`, `lane_west`, `materials`) with the layer on and off.
