# Couch co-op integration

Issue #71 adds one shared campaign world with two independent local player
slots. It does not relabel an AI companion as player two.

## Player flow

1. Select **Couch Co-op · Keyboard + Gamepad** on the campaign menu.
2. The mission boots full-screen for P1 and displays **P2 PRESS START**.
3. Press Start on a browser-standard gamepad to join P2 at the authored second
   spawn. The display switches to horizontal split (P1 top, P2 bottom).
4. Start toggles P2 out only while the mission-start checkpoint is open.
   Movement beyond 0.75 m or a player weapon shot closes that checkpoint.
5. Disconnecting P2 neutralizes every held input and restores P1 full-screen.

P1 remains keyboard/mouse. P2 uses the standard gamepad mapping documented in
[`input/README.md`](input/README.md): left stick move, right stick look, A jump,
B crouch, L3 sprint, LT aim, RT fire, X reload.

## Authority and policy

- One `ArenaDefinition`, `StaticWorld`, campaign runtime, enemy simulation, and
  event bus are shared.
- Each slot owns its camera, AABB motor, input, weapon state, ammo, recoil, and
  health.
- Player weapons carry `ownerId`; hit markers, HUD ammo, reload, aim, and health
  are filtered per slot.
- Friendly fire is **off** structurally: player capsules are not ballistic
  targets.
- AI selects the nearest **visible** active living player. If neither is
  visible, nearest living is used for last-known/search behavior. Dead and
  disconnected slots are excluded.
- One player dying does not fail the mission. A party wipe triggers the campaign
  checkpoint reload. P2 rejoin restores only P2 health, weapon, and spawn.
- Teammate bodies render only in the other camera's layer.

## Presentation

`CoopRenderCoordinator` renders the shared scene twice and never calls
simulation/update. Viewports tile the backing buffer exactly, including odd
heights, and restore renderer/camera state in `finally`.

The default menu and single-player path do not load co-op code. `src/coop/index`
is a lazy chunk loaded only by `?coop=1` or `?coopFixture=1`.

## Verification

```sh
node tools/verify-coop.mjs
node tools/verify-coop-trials.mjs --url=http://127.0.0.1:5273/
node src/coop/evidence/run-targeting.mjs
node src/coop/input/fixtures/run-isolation.mjs
node src/coop/render/evidence/run.mjs
```

`?coopFixture=1&campaignFixture=1&mission=<id>` uses a scripted standard pad for
automation while running the production motors, weapons, combat, cameras, and
renderer. It never mutates persisted campaign progress.

## Honest boundary

- Automated tests prove the browser `navigator.getGamepads()` join/disconnect
  seam with a standards-shaped injected device. A physical gamepad must still be
  run manually on the target gaming computer; no controller is attached to the
  build machine.
- Co-op uses the renderer's direct HDR/tone-mapped WebGL path rather than the
  single-camera postprocessing composer. Fullscreen AO/bloom remain disabled in
  split mode to hold frame budget and avoid running full-screen passes twice.
- Two players and horizontal split are the only supported topology.
