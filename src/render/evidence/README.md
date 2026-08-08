# Temporal edge evidence

Run from the repository root:

```sh
node src/render/evidence/run.mjs
node src/render/evidence/negative-controls.mjs
```

The runner owns Vite on `127.0.0.1:5361`, refuses software rendering, captures
six deterministic 120-frame camera sequences, and runs three independent
`EXT_disjoint_timer_query_webgl2` trials for SMAA, 2× MSAA, and 4× MSAA across:

- 1920×1080 CSS at DPR 1;
- 1512×982 CSS at uncapped Retina DPR 2; and
- the same Retina viewport under the production auto-DPR policy.

The primary shimmer metric is the p95 temporal second difference at edge pixels
inside canonical patches reprojected from known world-space bar and specular
anchors. This compensates the commanded camera motion instead of treating
whole-frame movement as instability. Static edge energy measures sharpness.
Hard-stop and reveal residuals measure ghost decay against the settled pose.

The runner refuses unknown AA/profile labels and any staged or unstaged tracked
source, then records requested/effective AA, RGBA16F sample support, composer
samples, DPR, CSS size, and actual drawing-buffer size. Development-only sample
capability forcing proves 4×→2×→SMAA fallback.

`generated/blind/` retains compact cap and fallback comparisons only.
`generated/blind-key.json` stays away from the critic. Raw per-frame arrays and
rejected-mode contact sheets are not committed; `metrics.json` keeps the named
distributions, controls, diagnostics, and all timing trials.
