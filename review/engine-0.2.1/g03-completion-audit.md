# G03 completion audit — not complete

2026-09-26. G03 remains **active**. This is a requirement-by-requirement working audit, not completion approval. The later G04–G07 goals remain inactive.

Latest evidence audit: [machine record](g03-final-evidence-audit.json). Current native runtime/harness hashes, archived checks and all eight room cases were revalidated. The room CLI now logs preflight observations; reconstructing its previous bytes reproduces the old hash, and all other room harness files match. A new complete recapture stopped at capture 7 because CPU speed limit fell from 100 to 53 after the Intel reference run. Six accepted captures plus the rejected raw seventh capture are retained; this incomplete population cannot establish stability. Awaiting an idle/cooldown window requested from the user.

| Requirement | Current evidence | Assessment |
| --- | --- | --- |
| Frozen 16×16 / 64-invocation / 128-index ABI, per-view ownership and bounds | Generated layout/cull/resolve, `deferred-tiles.test.mjs`, actual-device preflight and 31 focused tests | Passed; approved generated cost admission also passed |
| Independent CPU membership oracle, no false negatives | [Point correctness](g03-point-correctness.json): both native adapters, 32 forced parity/overflow cases and 47 boundary cases | Passed on current runtime |
| Near plane, inside sphere, projection/reverse/remapped depth, jitter, empty/background/extreme range, source mutation | Same current-source native matrix, including actual removal/re-addition | Passed |
| Same-frame local and total storage exhaustion without double count | Native capacity=2 / records=2 / records=0 modes and complete-image comparison | Passed |
| Source capacity rejects 1025 and recovers at 1024, strict and explicit Forward | Native source-capacity cases in current correctness evidence | Passed |
| Four-view isolation, resize, dynamic reuse and safe lifetime | Current native four-view checks plus source/tile lifecycle tests; old G02 source-bound reference evidence superseded by current-source rerun | Passed, including [current G02 reference regression](g03-point-reference-regression.json) |
| Optimized BRDF preserves complete source contribution | 30 added roughness/metallic compact/full-list comparisons plus original G02 artifact hash invariant | Passed; tolerances unchanged, not bit-exact |
| Frozen 128/256 sparse/overlap room on both devices, HDR/LDR | [Current eight-case room matrix](g03-point-room-matrix.json), matching runtime/harness hashes, full 720p pixels and 3,600-entry heatmaps | Passed; smoke timings excluded from performance qualification |
| Cull/resolve/full GPU span, CPU/queue/upload/allocation/memory/heatmaps and raw paired samples | [Current 24-capture review](g03-point-performance-review.md), all hashes/current fingerprints revalidated | Evidence complete; AMD sparse GPU-span/lighting stability fails, so qualification remains incomplete |
| Sparse-256 ≥20% light-stage improvement; overlap-128 ≤10% extra whole-GPU cost or measured correct bypass | Current pooled 900 samples/path: sparse lighting −89.6%/−94.2%; overlap GPU −13.7%/−9.2% | Relative budgets pass on both devices; separate stability requirement still open |
| Broader 60/30 FPS and full device qualification | ADR 0109 and [G02→G03 handoff](g03-handoff.md) assign final absolute performance/device qualification to G05/G07 | Must hand off remaining absolute gaps explicitly; cannot claim release performance |
| Repository typecheck/tests/build, API/docs/module/responsibility/prepare | `artifacts/engine-0.2.1/g03/point-checks/`: typecheck, 1,349 tests, 95 fresh examples and listed checks | Passed |
| Package and ordinary-consumer isolation | Current deterministic actual pack/install/browser/Node/TS/export/CLI check, archived in point-checks | Passed within existing budgets; no export/version changes |
| Shader generation consistency and cost | 417,394 B / 71 files / 63 variants/pipelines; user approved 418,480 / 71 / 63 and configuration was applied exactly | Passed: [application record](g03-budget-application.json), 10 policy tests and all four cap/cap+1 boundaries |
| Full Shader Language / Stage14 DAG | Complete `shader-language:check` and unchanged Stage14 DAG; all 25 nodes passed with one build per workspace | Passed; reports/logs archived in `approved-budget/` |
| Final evidence revalidation, G04 handoff and milestone close | [Final evidence audit](g03-final-evidence-audit.json) rechecks correctness, provenance, package/root checks and approved Shader admission; handoff remains draft | Performance acceptance and milestone close remain incomplete; do not close G03 |

No failed capture is deleted or replaced with a passing retry. The additional same-pipeline diagnostic is explanatory, not a substitute for the independent three-cohort gate. No slower samples are dropped and no CPU/GPU threshold is widened.
