# Issue #29 verdict

**BLOCKED:** 4× MSAA is not a safe global default at production Retina
resolution. Ship SMAA Ultra with automatic DPR capping, preserve the instrument,
and keep #29 open.

The final ANGLE Metal / Apple M4 matrix used three true-GPU trials per mode:

| Profile | SMAA p95 | 2× MSAA p95 | 4× MSAA p95 |
| --- | ---: | ---: | ---: |
| 1920×1080 drawing buffer | 10.831 ms | 11.592 ms | 12.553 ms |
| 1512×982 CSS / DPR 2 (3024×1964) | 21.677 ms | 25.092 ms | 26.784 ms |
| Retina production cap (2268×1473) | 15.748 ms | 15.271 ms | 18.540 ms |

At DPR 1, 4× MSAA still improves the worst normal-motion metric by about 15%
with negligible static sharpness loss. That result does not generalize to
Retina: uncapped DPR 2 misses 60 fps for every tested mode. Under the production
cap, 2× MSAA makes temporal noise 1.3% worse and 4× improves it only 4.8% while
still failing p95. Neither clears the predeclared 10% temporal gate.

The shipping safeguard caps auto DPR at 1.5 and about 3.34 million
drawing-buffer pixels, then keeps SMAA Ultra. Relative to uncapped Retina SMAA,
the cap reduces pixels by 43.75%, lowers worst paired p95 from 21.677 to
15.748 ms, and measures 0.59% lower static edge energy. Temporal noise rises
5.49%, so the cap is a budget safeguard—not claimed as a temporal improvement.
The anonymized cap sheets retain that visual tradeoff.

A separate no-query production-main run used the same 1512×982 CSS Retina
profile. Its three paired p95 values were 15.101, 14.859, and 14.124 ms with
zero console errors.

RGBA16F reports `[4, 2]` samples on this machine. Development capability forcing
proves deterministic `4× → 2× → SMAA Ultra` fallback and records requested and
effective modes, composer samples, DPR, and actual drawing-buffer dimensions.
Unknown AA labels and dirty tracked source are both refused by negative controls.

TAA remains blocked: the renderer has no motion-vector buffer, persistent
depth/history contract, or object-motion/disocclusion rejection path. Naive
history remains a failing ghost control only.

All static, jitter, blur, unrejected-history, wrong-compensation, capability,
invalid-mode, dirty-tree, and console-error controls pass. Earlier closing claims
in this branch are superseded; the measured Retina result does **not** satisfy
the issue-closing criterion.
