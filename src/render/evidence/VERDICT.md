# Issue #29 verdict

**CHANGE:** use 4× multisampling on the half-float composer target instead of
SMAA Ultra by default.

The deterministic 1920×1080 ANGLE Metal / Apple M4 matrix measured the required
six 120-frame sequences. Against SMAA Ultra, 4× MSAA reduced the worst normal
motion edge-noise p95 by 15.5%. The thin-bar p95 improved by 46.0% during fast
yaw and 49.0% during lateral translation. Static edge energy fell only 0.4%;
hard-stop/reveal ghost scores stayed below 1.0 and did not regress materially.

Three true GPU trials per mode put the chosen mode at 13.367 ms worst paired
p95, leaving 3.333 ms of the 16.7 ms budget. There were zero console errors or
disjoint timer events.

The final SMAA timing set is retained with an explicit **FAIL**: one of its
three trials reached 17.231 ms p95 while the other two were 9.971 and
10.247 ms. It was not replaced by a more convenient retry. All three selected
4× MSAA trials passed at 13.367, 12.180, and 13.266 ms p95.

A separate no-query production-main smoke produced 120 GPU samples at
12.676 ms median / 13.698 ms paired p95 with zero console errors.

FXAA, 2× MSAA, and 2× MSAA plus SMAA did not clear the predeclared 10% aggregate
temporal-improvement gate. The hybrid also cost more than 4× MSAA. They remain
URL-addressable evidence modes, not production defaults.

TAA remains blocked rather than approximated: this renderer has no motion-vector
buffer, persistent depth/history contract, or object-motion/disocclusion
rejection path. Naive history is retained only as a negative control and fails
the measured ghost-trail gate.

The static, subpixel-jitter, deliberate-blur, unrejected-history, and
wrong-compensation controls all pass. This is a measured temporal improvement
without unacceptable blur, ghosting, or p95 cost, so the closing criterion for
#29 is met.
