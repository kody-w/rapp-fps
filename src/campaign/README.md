# Campaign library (`src/campaign`)

A renderer-light campaign core plus the production bridge for three reviewed
missions: **Cargo Breach**, **Relay Blackout**, and **Foundry Last Light**. The
core validates catalogs, runs progression, resolves deep links, and persists
schema-versioned progress without importing rendering or gameplay systems.
`CampaignSystem` is the deliberately browser-facing edge: it selects one
mission before engine construction, bridges combat events into progression,
updates the HUD, and reloads between missions so teardown is complete.

The production catalog is assembled only from the reviewed mission adapters in
`production.ts`. It fingerprints all three real arenas and throws if two are
structurally identical. No placeholder world can masquerade as a campaign slot.
`?campaignFixture=1&mission=<id>` selects a mission with memory-only progress;
the fixture can never unlock or complete the persisted campaign.

## Why it exists

The campaign must remain authorable, validatable, and simulatable independently
of the browser-facing composition. The generic core therefore stays pure logic
over injected adapters:

- geometry is validated against the **real** collidable solids of each arena;
- progression is a set of pure reducers plus a thin stateful wrapper;
- every environment effect (storage, navigation, events) is an **interface** with
  an in-memory test double, so the whole thing runs and is proven in plain Node.

## Public surface

The generic core remains available from `./index.js`:

```ts
import {
  createCampaignCatalog, cargoBreach, relayBlackout, foundryLastLight,
  CampaignRuntime,
  createLocalStoragePersistence, createQueryNavigation,
} from './campaign/index.js';

const catalog = createCampaignCatalog([cargoBreach, relayBlackout, foundryLastLight]);
const runtime = CampaignRuntime.create({
  catalog,
  persistence: createLocalStoragePersistence(window.localStorage),
  navigation: createQueryNavigation({ getSearch, setSearch, reload }),
  emit: (e) => bus.emit(e.type, e),      // bridge to the core EventBus
});

const arena = runtime.currentArena();     // hand to ArenaLevel
const spawn = runtime.spawnSlot();        // hand to the player system
const hud   = runtime.snapshot();         // hand to the HUD (plain data)
```

Production `main.ts` uses `CampaignSystem.create(...)`, which owns the real
storage/query/reload bridge and exposes the selected definition and spawn before
the engine is composed. Nothing in the generic core forces a browser: swap
`createLocalStoragePersistence` for
`createInMemoryPersistence()` and `createQueryNavigation` for
`new InMemoryNavigation()` and it runs headless — which is exactly what the proof
suite does.

## File map

| File | Responsibility |
| --- | --- |
| `ids.ts` | Branded `MissionId`, kebab-case pattern, `asMissionId`/`tryMissionId`/`isMissionId`. |
| `types.ts` | The `MissionDefinition` contract: spawns, enemies/cover, objective (`title`+`summary`), completion/failure/checkpoint policy, optional visual metadata. |
| `spawns.ts` | AABB capsule-vs-solid clearance geometry; `deriveClearFloorSpawn` (throws rather than invent a point inside solids). |
| `missions/cargoBreach.ts` | Cargo Breach adapter over shipping `buildArena()`; second spawn derived + validated. |
| `missions/relayBlackout.ts` | Relay Blackout adapter over the reviewed switchyard mission library. |
| `missions/foundryLastLight.ts` | Foundry Last Light adapter over the reviewed foundry mission library. |
| `missions/index.ts` | Exports the three reviewed mission adapters. |
| `production.ts` | Ordered production catalog plus fail-fast cross-mission topology uniqueness. |
| `CampaignSystem.ts` | Browser/gameplay bridge: mission selection, HUD, combat progression, memory-only fixtures, reload lifecycle, and evidence seam. |
| `catalog.ts` | `createCampaignCatalog` — validates ids/orders/spawns/cover/objective (title+summary)/progression against real geometry; every rejection is a typed `CampaignValidationError.code`. |
| `progress.ts` | Pure `CampaignProgress` state machine: locked→unlocked→current→completed, elimination→unlock, death→checkpoint retry, finale→campaign complete. A current mission and `campaignComplete` are mutually exclusive by construction. |
| `deepLink.ts` | `resolveDeepLink` — explicit `resolved`/`locked`/`unknown`/`absent` union, each carrying a `fallbackMissionId` (`defaultMissionId`) for URL normalization; **never forges completion**. |
| `events.ts` | HUD-facing `CampaignEvent` union + `CampaignSnapshot` (with `currentObjectiveTitle`, `missionCount`, `furthestUnlockedIndex`, `finaleMissionId`) and `buildCampaignSnapshot`. |
| `persistence.ts` | Schema-versioned save; `parseCampaignSave` refuses malformed/future data and migrates known-older; injectable `KeyValueStore`. |
| `navigation.ts` | `NavigationAdapter` seam + `InMemoryNavigation` double so tests never touch `location`. |
| `campaign.ts` | `CampaignRuntime` — composes the above: hydrate → resolve deep link (deploy `resolved`, normalize `locked`/`unknown` URLs, preserve completion on reload) → advance → persist → emit. |
| `index.ts` | The public re-export surface. |
| `test/authoring.ts` | **Test-only** arena helpers (`box`/`onFloor`/`roomShell`/`assembleArena`) used to synthesise fixture arenas — never shipped, never the level's private helpers. |
| `test/fixtures.ts` | **Test-only** synthetic `fixture-*` missions so the suite can exercise multi-mission logic without shipping fake missions. |
| `test/run.ts` | The deterministic proof suite (pure logic). |
| `test/run-campaign.mjs` | Browser-free Node runner (compile → run → write evidence). |
| `test/tsconfig.test.json` | Emit-only tsconfig for the runner. |
| `evidence/report.json` | Committed, reproducible proof output. |

## The mission contract

A `MissionDefinition` is order-keyed, self-describing and renderer-light:

- **`id` / `order` / `title` / `brief`** — identity and briefing text.
- **`objective`** — `eliminate` / `reach` / `secure` with a non-empty `title`
  (the stable HUD banner, e.g. `SECURE THE CARGO BAY`) and a non-empty `summary`.
- **`createArena(): ArenaDefinition`** — the level factory. The reviewed mission 1
  is literally `buildArena`; integration-supplied missions return their own
  `ArenaDefinition` from the Foundry factory. Called by the catalog to validate
  cover/spawns against the real geometry.
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
| G2 | Production catalog contains Cargo → Relay → Foundry, with two clear spawn slots and collidable enemy cover in each | ✅ validated |
| G3 | All three arena topology fingerprints are distinct; duplicate mutation fails | ✅ fail-fast |
| G4 | Browser-free Node suite runs green over every enumerated scenario | ✅ 19/19, exit 0 |
| G5 | Catalog rejects dup id/order, gaps, `<2` spawns, missing cover/objective (title+summary), invalid progression | ✅ each throws a typed code |
| G6 | Deep link unknown/locked returns an explicit resolution and normalizes the URL to the default mission, never forges completion | ✅ union + normalization proven |
| G7 | Persistence has a schema version; malformed/stale/version-mismatch refused/migrated; in-memory injectable | ✅ proven |
| G8 | Mission 1's second spawn is derived and validated clear of collidable solids | ✅ clearance asserted |
| G9 | Navigation/reload is an interface; tests never mutate `location` | ✅ in-memory double |
| G10 | `campaignComplete` and a current mission are mutually exclusive; post-finale deploy/replay reopen cleanly; a completed reload stays complete | ✅ invariant + reload identity proven |
| G11 | Browser contract proves locked links, retry reload, progression hydration, one HUD/canvas, and explicit finale | ✅ `tools/verify-campaign.mjs` |
| G12 | Every mission passes the production gameplay judge three times on hardware GPU | ✅ 9/9; worst p95 8.767 ms |

Scenario coverage in `test/run.ts`: default fresh state · deep link
locked/unlocked/unknown/absent + URL normalization · elimination progression ·
death→checkpoint retry (both `last-checkpoint` and `mission-start`) · final
completion · post-finale replay/deploy invariant · final reload identity ·
persistence hydration/malformed/version-mismatch/migration · two validated spawn
slots · objective title + HUD snapshot fields (`missionCount`,
`furthestUnlockedIndex`, `finaleMissionId`) · an 18-way catalog negative-control
battery · determinism (identical event sequence across two runs). Multi-mission
scenarios compose `cargoBreach` with two synthetic `fixture-*` missions
(`test/fixtures.ts`); the shipping surface exports only the reviewed mission.

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
  angle. The reviewed mission 1 (which must not edit its level file) derives its
  second slot this way; integration-supplied missions are free to author or derive
  theirs. The synthetic test fixtures hand-place both slots.
- **One defender per mission.** The catalog supports multiple enemy placements,
  but the current production AI/Combat composition binds one defender. Each
  mission therefore completes on one independently confirmed elimination.
- **Migration covers exactly one prior version (v1→v2).** Anything older than v1,
  or a future version, is refused (clean fresh start), never guessed at. That is
  deliberate — a downgrade must not reinterpret data it does not understand — but
  it means old saves beyond one hop are simply dropped.
- **Transitions reload the document.** This is intentional: it guarantees the
  level, renderer resources, HUD, audio, input listeners, and campaign
  subscriptions are torn down before the next mission is built. It costs a
  loading boundary rather than attempting a risky in-place object-graph swap.
- **The proof compiles to `dist/campaign/` and dynamic-imports the emitted JS.**
  Node 20 cannot execute the repo's `.js`-specifier-to-`.ts` imports directly, so
  the suite runs against compiled output. It is the same JS `tsc` would emit, but
  it is one build hop removed from the `.ts` sources (mitigated by G1 typechecking
  the sources directly, repo-wide, every run).
- **Visual evidence is machine-specific.** Relay and Foundry carry authored
  1920×1080 frames, and the integrated browser gate captures all three cold
  roots. Performance qualification is Apple M4/Metal evidence, not a claim about
  every gaming PC GPU.
