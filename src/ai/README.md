# Deterministic industrial-security AI

`src/ai/` is an independently testable decision library and debug harness. It is **not**
registered in production and does not import player, weapon, or level implementations.

## Behavior

The fixed-step state machine covers:

`idle / patrol → suspicious → investigate → engage → suppress → reposition → search → return`

An externally confirmed elimination enters the terminal `eliminated` state. Hearing alone
cannot enter `engage`; line of sight must survive the configured reaction delay.

`SecurityAgent` provides:

- distance/FOV vision with `PerceptionRaycastPort.isOccluded`;
- canonical `Footstep` compatibility (`position`, shared `SurfaceKind`, `loud`);
- reaction delay plus seeded, decaying target memory that keeps identity paired with position;
- scheduled burst, aim-error, suppression, and reposition intents without weapon imports,
  preserving final-shot-plus-cooldown deadlines across tactical transitions;
- fixed-buffer cover scoring using visible or remembered target position plus exposure,
  finite path cost, and flank weights;
- fixed-buffer path requests through `NavigationPathPort`;
- local `ResolvedDamageInput` consumption after the host resolves health/damage;
- deterministic xorshift decisions from an explicit seed.

The AI never resolves hits, emits final Damage events, owns a nav mesh, or claims health
authority.

Terminal resolved damage bypasses alert transitions. A surviving sourced hit during search
restarts investigation and replaces the search path with the supplied source position.

## Local ports

- `PerceptionRaycastPort`: target sampling and occlusion query.
- `NavigationPathPort`: fixed-capacity path fill and cost estimate.
- `CoverCandidatePort`: fixed-capacity candidate fill.
- `CombatIntentSink`: aim, burst, suppress, reposition, and cease intents.
- `ResolvedDamageInput`: local adapter input, not a proposed shared authority contract.

Tick scratch storage is preallocated: 16 path points and 12 cover candidates per agent.
Agent-owned setup allocations are counted at their allocation sites, and the dynamic
fixed-step counter remains zero in the production class. The evidence recorder is optional
and capped at 512 events.

## Evidence

```sh
npx tsc --noEmit
npx vite build --config src/ai/vite.config.mjs
npx vite --config src/ai/vite.config.mjs
# in another shell
node src/ai/evidence/run.mjs
```

The strict Vite server owns `127.0.0.1:5341`.

- `evidence/report.json`: deterministic timelines; occluded-memory, unreachable-cover,
  burst-deadline, memory-identity, target-reaction, and damage-priority regressions;
  fixed-frame 30/60/144 accumulator
  coverage; the 50-agent benchmark; allocation instrumentation; and mutation summaries.
- `evidence/visual-report.json`: hardware renderer plus the unmodified core profiler
  fields, explicit 16.7 ms paired-budget verdict, and an over-budget nonzero-exit fixture.
- `evidence/{patrol,investigate,engage,search,cover}.png`: named debug shots.

The harness shows the vision cone, last-known position, requested path, scored cover
candidates, selected cover, current state, and state/intent trace. The gold shape is an
abstract debug proxy: **no character model or animation is provided, and subjective
combat feel remains unverified.**

## Shared-contract request

Coordinator action requested:

1. Promote the proven canonical `FootstepPayload` shape
   `{ position: Vector3Like, surface: SurfaceKind, loud: number }`; core names it and
   both audio and AI now consume it.
2. Keep `PerceptionRaycastPort`, `NavigationPathPort`, `CombatIntentSink`, and
   `ResolvedDamageInput` local until real collision, navigation, combat, and health
   adapters prove their shapes. Do not promote speculative authority contracts.
