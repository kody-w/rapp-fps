# Combat HUD

`CombatHud` is a DOM presentation subsystem with one `requestAnimationFrame`
writer. It creates its nodes once, consumes public bus messages or its narrow
status methods, and never imports weapon implementation code.

```ts
const hud = new CombatHud({
  profiler: {
    snapshot: () => engine.profiler.snapshot(),
    drawCalls: () => sceneStats.drawCallsPerFrame,
    budgetMs: 16.7,
  },
});
engine.add(hud);
```

The compact performance overlay is not mounted unless the URL contains the
exact flag `?hudDebug=1`. It reads `gpuFrameMs.p95`, `cpuFrameMs.p95`, and the
paired `budgetFrameMs.p95`; rAF cadence is not treated as render cost.

## Input seams

Existing core events are consumed for damage, reload start/end, and ADS state.
The following local names support the harness and integration without touching
core-owned contracts:

- `weapon:status` — `WeaponHudStatus`
- `player:status` — `PlayerHudStatus`
- `combat:hit-confirm` — `HitConfirmedEvent`
- `combat:elimination` — `EliminationEvent`
- `hud:objective` — `ObjectiveHudStatus`
- `hud:interaction` — `InteractionHudStatus`

Core should publish these names (or canonical replacements) before other
subsystems emit them. Damage `direction` is defined here as the world-space
vector from the damaged player toward the source; core should make that
direction convention explicit when it adopts the payload.

## Evidence harness

Run from the repository root:

```sh
npx vite --config src/hud/vite.harness.config.mjs
node src/hud/tests/run-hud-tests.mjs
node src/hud/evidence/capture.mjs
```

The harness is fixed to port 5332 and exposes `hip`, `ads`, `reload`,
`damaged-left`, `low-health`, `hit-confirm`, and `objective` shot states. It
uses only system fonts and generated CSS geometry.
