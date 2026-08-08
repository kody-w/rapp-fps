# Temporal edge evidence

Run from the repository root:

```sh
node src/render/evidence/run.mjs --modes=ultra
```

The runner owns Vite on `127.0.0.1:5361`, refuses software rendering, captures
six deterministic 120-frame camera sequences at 1920×1080, and runs three
independent `EXT_disjoint_timer_query_webgl2` trials per AA mode.

The primary shimmer metric is the p95 temporal second difference at edge pixels
inside canonical patches reprojected from known world-space bar and specular
anchors. This compensates the commanded camera motion instead of treating
whole-frame movement as instability. Static edge energy measures sharpness.
Hard-stop and reveal residuals measure ghost decay against the settled pose.

`generated/blind/` and `generated/blind-metrics.json` omit the AA names.
Keep `generated/blind-key.json` from a critic until their comparison is done.
The negative-control sheet covers static, projection jitter, deliberate blur,
and unrejected exponential history. `metrics.json` is the complete named report.
