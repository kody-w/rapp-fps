# Procedural combat audio

This subsystem creates every sound at runtime from Web Audio oscillators,
deterministic noise buffers, filters, envelopes, dynamics compression, and a
safety waveshaper with true-peak headroom. The WAV files under
`evidence/generated/` are test renders only; runtime code never loads them or
any other audio asset.

## Integration

This PR is a subsystem library and evidence harness only. Directory ownership
prevents editing `src/main.ts`, so production registration and the gesture UI
remain a coordinator integration request. A core owner can register the system
without exposing weapon or player internals:

```ts
import { AudioSystem } from './audio/index.js';

const audio = new AudioSystem({ seed: 0x72617070 });
engine.add(audio);
```

Call `audio.arm()` directly inside a click, pointer, or key gesture. No
`AudioContext` exists before that call. Events received while `status.state` is
not `armed` are counted and dropped, never queued. UI can read `audio.status` or
subscribe with `audio.subscribeStatus(...)`. Safari/iOS `interrupted` is exposed
as a retryable state; a later gesture may call `arm()` again.

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
through `OfflineAudioContext`, and rewrites `evidence/generated/`. It refuses to
run without the Playwright-pinned Chromium or FFmpeg. FFmpeg
`ebur128=peak=true` supplies ITU-R BS.1770-compatible true peak, with an explicit
**-1.0 dBTP** ceiling. It asserts:

- every limiter-on WAV stays at or below -1.0 dBTP, while limiter-off fails;
- limiter-off only passes as a negative control when its metric exists, is
  finite, and exceeds -1.0 dBTP; missing and silent-WAV mutations are rejected;
- 44.1/48 kHz stereo hard-left/center/right 30-round bursts pass at maximum
  supported `masterGain=1` across fixed seeds including `1918988402`;
- RMS, approximate ungated LUFS, crest factor, duration, DC offset, spectral
  centroid, and five energy bands are reported for shots and every surface;
- a 30-round burst has bounded source concurrency, a stable silent tail, and
  no live sources after rendering;
- the dedicated same-seed probe produces byte-identical canonical 10-bit PCM
  in 16-bit WAV containers;
- another seed changes the render without an unbounded loudness change;
- all surface comparisons use the same seed, render duration, event time, and
  position; seed variation is tested separately;
- adjacent deterministic footsteps do not repeat;
- spatial panning and distance attenuation are measurable;
- events before arming allocate no `AudioContext` and are not replayed;
- `interrupted` resumes on retry and dispose wins a pending-resume race.

`report.json` also records scheduling cost, offline render cost, listener-update
cost, nodes created per shot, FFmpeg version, Playwright package version, and
the pinned Chromium version. All matrix cases are generated and measured on
every run; only the measured worst-case matrix WAV is retained to keep branch
evidence small. Audio creates no WebGL resources and does not enter the renderer,
so GPU work is unchanged.
