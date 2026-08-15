# Player fixtures — the ramp blocker's witness

These two files exist so the slope defect that blocked draft PRs **#3/#13** is a
**re-runnable experiment**, not a review comment. Issue **#36** (parent **#32**)
made a deliberate call: ship the proven, axis-aligned-box locomotion now, and
make the unverified slope path *unreachable* rather than merely untested. That
call is only honest if the defect it routes around is demonstrable. This is the
demonstration.

Nothing here is shipped. Nothing here is imported by `src/player/index.ts`. Both
files are `.mjs` and run directly on Node with the repo's `three` /
`three-mesh-bvh` already installed.

| file | what it is |
| --- | --- |
| `pr13-mesh-solver.mjs` | A **faithful line-for-line JS port** of the prior mesh capsule solver, `pr13:src/player/StaticCollisionWorld.ts` (git ref `20c038f`, fetched via `git fetch origin refs/pull/13/head:pr13`). Types stripped, logic unchanged. Diff it against the ref to confirm. |
| `finite-ramp-defect.mjs` | Drives that solver up and over **real finite solid ramps** at the engine's 120 Hz fixed step and measures what it does. Writes `finite-ramp-defect.report.json`. |

## Run it

```sh
node src/player/fixtures/finite-ramp-defect.mjs
```

No build step, no dev server. It prints a per-angle table and a verdict, and
writes the full per-tick trajectory of the worst case to
`finite-ramp-defect.report.json` beside it.

## What it builds

A finite solid a thin "infinite ramp" test fixture cannot model:

- a **box** approach floor (top at `y = 0`),
- a **solid triangular wedge** rising over a 3 m run, and
- a **box** top platform.

That gives the two *seams* a real solid has: the **concave floor→slope** seam at
the ramp foot, and the **convex slope→platform** seam at the top. The capsule is
walked from the floor, up the wedge, onto the platform. The ramp **angle** is
swept; every angle in the sweep is below PR #13's own 50° walkable limit, so a
correct solver should carry the capsule smoothly over all of them.

## The metric

The headline number is the **uncommanded per-tick vertical pop**: for each tick,
`|Δy|` minus the fastest vertical move the ramp grade can justify
(`grade · |Δz|`) minus a 5 mm tolerance. On a perfectly followed ramp this is
**0**. Anything above it is the solver moving the body vertically on its own.

It is solver-owned and unarguable. On the worst tick, `moveCapsule` is handed a
small **downward** input displacement (gravity) yet returns the body lifted by
~180 mm — the motor asked it to go down; the solver threw it up.

## What it found (this machine, `three` 0.185.1)

```
  angle    airborne   max uncommanded pop   reached top   verdict
   16.7 deg       0           0.0 mm        yes        clean
   20.1 deg       0           0.0 mm        yes        clean
   23.4 deg       0           0.0 mm        yes        clean
   26.6 deg       0         116.4 mm        yes        DEFECT
   29.5 deg       0         123.4 mm        NO         DEFECT
   32.4 deg       0         137.1 mm        NO         DEFECT
   37.5 deg       0         154.2 mm        NO         DEFECT

VERDICT: REPRODUCED
```

Read this carefully, because it is more specific than "the solver is broken":

- **The defect is not universal.** On gentle ramps (≤ ~23°) the solver stays
  glued and smooth — 0 pop. A single infinite-ramp fixture at a gentle angle
  would have shown nothing, which is likely how the original blocker turned into
  a contested claim.
- **It switches on sharply near 25°** — still a walkable grade, gentler than a
  typical staircase — where the capsule is thrown **up the ramp foot by
  116–154 mm in one tick**, and worsens with angle. The prior review reported
  45–57 mm; on a finite solid it is **worse**, not milder.
- **The pop happens while the solver reports itself grounded** (`airborne = 0`).
  An uncommanded 150 mm vertical jerk with the feet still "on the ground" is a
  camera pop a player sees instantly — arguably worse than going briefly
  airborne, because nothing flags it.

### Honesty note: solver-owned vs driver-influenced

The **pop** is solver-owned (see the metric above). The **"reached top"** column
is softer: whether the capsule summits also depends on this fixture's *reduced*
motor projecting velocity along the contacts the solver reports, so a `NO` there
means "this motor + this solver stalled on the ramp", not solely a solver claim.
The verdict leans only on the pop. Do not over-read the summit column.

### The mechanism

The prior solver depenetrates iteratively along the **capsule→triangle** vector,
which flips toward an edge/vertex direction at a triangle seam rather than
following the face normal, and it treats the steep ramp foot as a climbable
`maxStepHeight` step. At the foot of a walkable-but-steep wedge that produces a
single-tick upward launch. On axis-aligned boxes none of this can arise: every
face normal is exactly ±X/±Y/±Z, steps are honest discrete ledges, and there is
no closest-point-on-triangle to get subtly wrong.

## Why this justifies the box-only slice

The shipped subsystem cannot express any of this geometry. `StaticWorld` is
axis-aligned boxes and `assertValidStaticWorld` throws on anything degenerate,
out-of-bounds, or — by construction — non-axis-aligned. There is no export that
ingests a wedge. So the code path this fixture indicts is **unreachable in the
game, not merely unexercised by tests**.

Slopes return later under their own issue. When they do, a slope solver must
drive this fixture's pop to ~0 across the whole sweep **before** it ships. Until
then, this is the witness that says why they are gone.
