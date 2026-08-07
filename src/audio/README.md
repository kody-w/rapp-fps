# Procedural combat audio

This subsystem creates every sound at runtime from Web Audio oscillators,
deterministic noise buffers, filters, envelopes, dynamics compression, and a
safety waveshaper with true-peak headroom. The WAV files under
`evidence/generated/` are test renders only; runtime code never loads them or
any other audio asset.

## Integration

The subsystem imports only the shared core contracts. A core owner can register
it without exposing weapon or player internals:

```ts
import { AudioSystem } from './audio/index.js';

const audio = new AudioSystem({ seed: 0x72617070 });
engine.add(audio);
```

Call `audio.arm()` directly inside a click, pointer, or key gesture. No
`AudioContext` exists before that call. Events received while `status.state` is
not `armed` are counted and dropped, never queued. UI can read `audio.status` or
subscribe with `audio.subscribeStatus(...)`.

Only these canonical shared events are consumed:

- `Events.WeaponFired`
- `Events.BulletImpact` (`material` is treated as canonical `SurfaceKind`)
- `Events.Footstep`
- `Events.ReloadStart`
- `Events.ReloadEnd`
- `Events.Damage`

World positions, when present in those payloads, drive stereo panning,
distance attenuation, high-frequency distance shaping, and a short bounded
propagation delay. Listener pose is read from the shared engine camera during
`update`.

## Reload contract gap

`ReloadStart` and `ReloadEnd` expose no duration, position, weapon action,
magazine remove/insert phase, or chamber/bolt phase. Audio therefore supplies
neutral mechanical start/end bookends only. A phase-accurate reload sequence
requires that state in the shared contract; this subsystem does not infer it
from weapon internals.

## Deterministic evidence

Run from the repository root:

```sh
node src/audio/evidence/run.mjs
```

The harness owns Vite port **5333**, clicks the explicit arm gesture, renders
through `OfflineAudioContext`, and rewrites `evidence/generated/`. It asserts:

- sample peak and cubic-interpolated true-ish peak stay below clipping;
- RMS, approximate ungated LUFS, crest factor, duration, DC offset, spectral
  centroid, and five energy bands are reported for shots and every surface;
- a 30-round burst has bounded source concurrency, a stable silent tail, and
  no live sources after rendering;
- identical seeds produce byte-identical signed 16-bit PCM and WAV hashes;
- another seed changes the render without an unbounded loudness change;
- bypassing the limiter clips and causes the real clipping assertion to fail;
- adjacent deterministic footsteps do not repeat;
- spatial panning and distance attenuation are measurable;
- events before arming allocate no `AudioContext` and are not replayed.

`report.json` also records scheduling cost, offline render cost, listener-update
cost, and nodes created per shot. Audio creates no WebGL resources and does not
enter the renderer, so GPU work is unchanged.
