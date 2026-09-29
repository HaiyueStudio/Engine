# G05 native resource and capacity checkpoint — 2026-09-28

Status: **correctness/resource smoke passed; performance qualification incomplete**. Full raw artifact paths and SHA-256 values are in the [machine-readable index](g05-native-resource-checkpoint.json). Runtime fingerprint remains `43eaf828b7dc68a3f6e7bdd1e591bf71d07d6ad4f47b777ec54a9ae5fe5c5baf`.

## Native coverage

| Suite | Current evidence |
| --- | --- |
| E/G rooms | 52/52 captures: 13 workload/motion combinations × reference/tiled × AMD/Intel |
| Per-view pixels | 64 comparisons; maximum HDR tolerance ratio 0.488, maximum LDR delta approximately 1 channel level (limits 1 and 2 respectively) |
| Allocation attribution | All warm/CPU/GPU snapshots reconcile with the detailed shared tracker; per-view/total budgets pass |
| Static light sources | 16 static captures, zero source reuploads in either measured population |
| Moving light sources | 36 moving captures, one shared source upload per measured frame, including four views |
| Stable resource creation | 104 CPU/GPU populations: zero newly created buffers, bind groups and render pipelines |
| Cleanup | Zero owner and live-GPU-resource residue across all 52 captures |
| Default Forward | Four G01 same-workload native smoke cases pass, with zero Deferred resource/shader creation and zero residue |

The room matrix includes single-1/small-8/sparse-128/sparse-256 static supplements; all named dynamic E cases; and both 512/1024-light, 1080p high-overlap G diagnostics. It preserves the complete authored/submitted-light coverage checks. These are three-sample smoke populations with reduced host CPU speed limits, so their timings cannot establish budgets or FPS.

Memory figures are based on tracked allocation descriptors, not driver residency. This steady-state matrix does not prove native safety or high water for two simultaneous unsubmitted generations, nor AO cost. Structural pending-generation evidence remains in the [memory review](g05-memory-review.md).

## Current-runtime core/capacity regression

Both native GPUs pass the unchanged A/B oracles against the current G05 runtime, without overwriting G02/G03/G04 evidence:

- Seven full-reference count cases per GPU: 0/1/8/9/32/128/256, with the independent contribution/material/view checks required by the original gate.
- 32 tiled cases per GPU, including forced local overflow, partial storage exhaustion and zero stored tiles. Complete-light fallback remains in the same frame.
- 47 geometric/BRDF boundary checks per GPU, four-view/resize/reuse and automatic reference/tiled transitions.
- A 1025-point source produces an explicit `point-capacity` failure under strict policy and a visibly restricted fallback under Forward policy. Returning to 1024 points recovers successfully. This is source-capacity behavior, not a claim of testing a physically smaller GPU.
- No validation errors or cleanup residue.

Logs are under `artifacts/engine-0.2.1/g05/checks/native-resources-2026-09-28/`. The Forward runner rebuilt and fingerprinted Engine dist before its native smoke matrix; room/core captures used the existing hash-verified current-source private bundle.

## Performance attempt and remaining work

The first full F attempt stopped at capture 15/96: rendering passed but CPU speed changed from 100 before capture to 82 afterward. Its terminal failed manifest and all raw samples remain at `instance-cohorts-2026-09-28T00-45-06.765Z.json`; no samples will be spliced into a later attempt. One earlier first-cohort 10k/single-view visible-frustum wall P95 was 21.58 ms, above the 16.67 ms ceiling; CPU/GPU timing channels were below their ceilings. Complete pooling and three-cohort stability remain unproven.

Pending: fresh qualified F and E/G cohorts, full default Forward ≤5% regression, native reduced-device-limit/pending-generation checks, attributed AO/cold pipeline costs and final audit. Host readiness must be rechecked after concurrent work naturally ends and cooling completes. G01 budgets, G04 AO semantics and required coverage are unchanged; G05 remains active.
