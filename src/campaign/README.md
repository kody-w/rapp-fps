# Campaign library (`src/campaign`)

A **renderer-light campaign contract** for three real missions. It lets a parent
integration build a validated mission catalog, run the whole progression state
machine, resolve deep links, and persist progress **without importing `three`,
the DOM, the HUD, the player/AI/weapon systems, or any not-yet-existing
Relay/Foundry branch**. The one and only dependency into the rest of the codebase
is the level's pure `ArenaDefinition` type from `../level/arena.js` — the same
data the shipping level already produces.

> Scope: this branch owns `src/campaign/**` and its own tests/evidence only. It
> does **not** edit `src/main.ts` or any existing level/weapon/player/AI/render/HUD
> file. Production wiring (bus bridge, real `localStorage`, real query/reload)
> lands later in the parent branches; this library exposes the seams they plug
> into. Refs #70.

## Why it exists

The campaign has to be authored, validated and simulated **before** the boot
(Relay) and level-factory (Foundry) branches exist, and without importing their
half-written code. So everything here is pure logic over injected adapters:

- geometry is validated against the **real** collidable solids of each arena;
- progression is a set of pure reducers plus a thin stateful wrapper;
- every environment effect (storage, navigation, events) is an **interface** with
  an in-memory test double, so the whole thing runs and is proven in plain Node.

## Public surface

Import everything from `./index.js`. Typical wiring once the parent branches land:

```ts
import {
  createCampaignCatalog, defaultCampaignMissions, CampaignRuntime,
  createLocalStoragePersistence, createQueryNavigation,
} from './campaign/index.js';

const catalog = createCampaignCatalog(defaultCampaignMissions());
const runtime = CampaignRuntime.create({
  catalog,
  persistence: createLocalStoragePersistence(window.localStorage),
  navigation: createQueryNavigation({ getSearch, setSearch, reload }),
  emit: (e) => bus.emit(e.type, e),      // bridge to the core EventBus
});

const arena = runtime.currentArena();    // hand to the Foundry/level factory
const spawn = runtime.spawnSlot();        // hand to the player system
const hud   = runtime.snapshot();         // hand to the HUD (plain data)
```

Nothing above forces a browser: swap `createLocalStoragePersistence` for
`createInMemoryPersistence()` and `createQueryNavigation` for
`new InMemoryNavigation()` and it runs headless — which is exactly what the proof
suite does.

## File map

| File | Responsibility |
| --- | --- |
| `ids.ts` | Branded `MissionId`, kebab-case pattern, `asMissionId`/`tryMissionId`/`isMissionId`. |
| `types.ts` | The `MissionDefinition` contract: spawns, enemies/cover, objective, completion/failure/checkpoint policy, optional visual metadata. |
| `spawns.ts` | AABB capsule-vs-solid clearance geometry; `deriveClearFloorSpawn` (throws rather than invent a point inside solids). |
| `authoring.ts` | Campaign-owned arena helpers (`box`/`onFloor`/`roomShell`/`assembleArena`) for missions 2–3 — never the level's private helpers. |
| `missions/cargoBreach.ts` | Mission 1 — the shipping `buildArena()` adapted; second spawn derived + validated. |
| `missions/blackfrostVault.ts` | Mission 2 — two defenders, checkpoint banks on kill, death resumes from it. |
| `missions/tidewallHold.ts` | Mission 3 (finale) — two defenders, death re-clears the hold. |
| `catalog.ts` | `createCampaignCatalog` — validates ids/orders/spawns/cover/objective/progression against real geometry; every rejection is a typed `CampaignValidationError.code`. |
| `progress.ts` | Pure `CampaignProgress` state machine: locked→unlocked→current→completed, elimination→unlock, death→checkpoint retry, finale→campaign complete. |
| `deepLink.ts` | `resolveDeepLink` — explicit `resolved`/`locked`/`unknown`/`absent` union; **never forges completion**. |
| `events.ts` | HUD-facing `CampaignEvent` union + `CampaignSnapshot` and `buildCampaignSnapshot` (plain data; HUD imports nothing from here-and-below). |
| `persistence.ts` | Schema-versioned save; `parseCampaignSave` refuses malformed/future data and migrates known-older; injectable `KeyValueStore`. |
| `navigation.ts` | `NavigationAdapter` seam + `InMemoryNavigation` double so tests never touch `location`. |
| `campaign.ts` | `CampaignRuntime` — composes the above: hydrate → resolve deep link → advance → persist → emit. |
| `index.ts` | The public re-export surface. |
| `test/run.ts` | The deterministic proof suite (pure logic). |
| `test/run-campaign.mjs` | Browser-free Node runner (compile → run → write evidence). |
| `test/tsconfig.test.json` | Emit-only tsconfig for the runner. |
| `evidence/report.json` | Committed, reproducible proof output. |

## The mission contract

A `MissionDefinition` is order-keyed, self-describing and renderer-light:

- **`id` / `order` / `title` / `brief`** — identity and briefing text.
- **`objective`** — `eliminate` / `reach` / `secure` with a non-empty `summary`.
- **`createArena(): ArenaDefinition`** — the level factory. Mission 1 is literally
  `buildArena`; missions 2–3 author their own arenas with `authoring.ts`.
- **`playerSpawns: [SpawnSlot, SpawnSlot]`** — exactly two floor-based insertion
  slots (`position[1] === 0`), each validated clear of collidable solids.
- **`enemies`** — defenders, each with ≥1 `coverSolidIds` that name a solid which
  actually exists and collides in the arena.
- **`completion` / `failure` / `checkpoint`** — the progression policy.
- **`visual?`** — optional cosmetic hints for a loading card.

## Running the proof

```sh
node src/campaign/test/run-campaign.mjs   # compile + run; exit 0 iff all green
npx tsc --noEmit                          # repo-wide typecheck stays clean
```

The runner compiles `run.ts` and its transitive imports (the campaign plus
`level/arena.ts`) into the gitignored `dist/campaign/`, marks it ESM, dynamic-
imports the emitted entry, runs the suite, prints a per-case summary, and writes
`evidence/report.json`. No renderer, no DOM, no network, no account.

## Measurable gates (all green)

| Gate | Statement | Status |
| --- | --- | --- |
| G1 | `npx tsc --noEmit` passes repo-wide with the campaign added | ✅ 0 errors |
| G2 | Working tree touches only `src/campaign/**` (+ ignored `dist/`) | ✅ campaign-only |
| G3 | Library imports no `three`/DOM/render/HUD/player/AI/weapon/`main`; only `../level/arena.js` | ✅ grep-clean |
| G4 | Browser-free Node suite runs green over every enumerated scenario | ✅ 15/15, exit 0 |
| G5 | Catalog rejects dup id/order, gaps, `<2` spawns, missing cover/objective, invalid progression | ✅ each throws a typed code |
| G6 | Deep link unknown/locked returns an explicit resolution, never forges completion | ✅ union proven |
| G7 | Persistence has a schema version; malformed/stale/version-mismatch refused/migrated; in-memory injectable | ✅ proven |
| G8 | Mission 1's second spawn is derived and validated clear of collidable solids | ✅ clearance asserted |
| G9 | Navigation/reload is an interface; tests never mutate `location` | ✅ in-memory double |

Scenario coverage in `test/run.ts`: default fresh state · deep link
locked/unlocked/unknown/absent · elimination progression · death→checkpoint
retry (both `last-checkpoint` and `mission-start`) · final completion · persistence
hydration/malformed/version-mismatch/migration · two validated spawn slots · a
15-way catalog negative-control battery · determinism (identical event sequence
across two runs).

## Honest weaknesses & limitations

- **Elimination-gated only.** `reach`/`secure` objectives and `reach-objective`
  completion are authored in the *types* but the slice still completes every
  mission by eliminations. A real trigger-volume/objective system is future work;
  the contract has the shape for it but no runtime for it yet.
- **Clearance model is an AABB capsule approximation.** Spawn validation models
  the player as a vertical cylinder (radius/height from `player/config.ts`) versus
  axis-aligned boxes. It matches the level's box-world contract but does **not**
  reproduce the shipping `PlayerMotor` step/slope logic, so it proves *"a standing
  capsule fits, clear of cover, over a floor slab"* — not *"the motor can path
  there"*. Floor slabs are identified heuristically (`collide`, top at `y≈0`), the
  same filter the AI occluder uses.
- **Second-spawn derivation is a deterministic search, not a tactical designer.**
  `deriveClearFloorSpawn` tries preferred tactical offsets then a grid scan and
  takes the first clear point ≥ the requested separation. It is reproducible and
  provably clear, but it optimises for *clearance*, not for a hand-tuned flanking
  angle. Missions 2–3 therefore hand-author their second slot; only mission 1
  (which must not edit its level file) derives it.
- **Migration covers exactly one prior version (v1→v2).** Anything older than v1,
  or a future version, is refused (clean fresh start), never guessed at. That is
  deliberate — a downgrade must not reinterpret data it does not understand — but
  it means old saves beyond one hop are simply dropped.
- **`CampaignRuntime` completion is driven by explicit `reportElimination()` /
  `reportPlayerDeath()` calls.** Wiring those to real gameplay signals (the enemy
  `death` event, the player `death` event) is the parent's job; this library does
  not subscribe to a bus, by design.
- **The proof compiles to `dist/campaign/` and dynamic-imports the emitted JS.**
  Node 20 cannot execute the repo's `.js`-specifier-to-`.ts` imports directly, so
  the suite runs against compiled output. It is the same JS `tsc` would emit, but
  it is one build hop removed from the `.ts` sources (mitigated by G1 typechecking
  the sources directly, repo-wide, every run).
- **No visual/screenshot evidence.** Missions 2–3 are authored geometry with no
  rendered capture in this branch (rendering is out of scope and would require the
  forbidden subsystems). Their correctness is asserted structurally, not visually.
