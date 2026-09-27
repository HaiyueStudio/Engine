# G03 completion audit — complete

2026-09-27. **G03 complete; G04 ready and not activated.** This closes named-device Tiled correctness, relative performance and stability. It does not qualify the full 0.2.1 device/performance matrix or release.

The [final machine audit](g03-final-evidence-audit.json) revalidates 108 unique evidence/source files before closing checks, current runtime/native/room harnesses, actual HTTP provenance, all raw captures, eight room cases, archived root/package checks and approved Shader admission. The current runtime matches the previously completed 1,349 tests, 95 fresh example builds and 25-node Stage14 chain. Host-only cooldown orchestration is covered separately by eight focused policy tests.

The [accepted full retest](g03-final-performance-review.md) contains 24 captures / 7,200 measured frames and 48 unthrottled host observations, with uniform 120-second idle and unchanged workload/thresholds. All four relative comparisons and all 32 stability channels pass. AMD overlap Tiled frameWall P95 is 34.730 / 34.075 / 35.190 ms (3.21% spread, 1.32% CV); the original two AMD sparse GPU channels also pass.

Earlier failures remain in [progress history](g03-progress.md), [cooled failed population](g03-cooled-performance-review.json) and [rejected browser-flags diagnostic](g03-browser-scheduling-diagnostic.json). A later competing game was confirmed and stopped by the user; the interrupted 14-capture population is retained separately. The accepted run restarted from capture 1 with no splicing. Prior audit snapshots are archived under the G03 artifact directory.

High-overlap absolute GPU/frameWall budgets still fail and are explicitly handed to G05/G07, as already defined by ADR 0109 and the G02 handoff. The generic cohort runner's exit 1 is preserved for those failures; relative/stability checks are independently recomputed. Closing checks and their hashes are in the machine audit.

| Requirement | Current evidence | Assessment |
| --- | --- | --- |
| Frozen 16×16 / 64-invocation / 128-index ABI, per-view ownership and bounds | Generated layout/cull/resolve, `deferred-tiles.test.mjs`, actual-device preflight and 31 focused tests | Passed; approved generated cost admission also passed |
| Independent CPU membership oracle, no false negatives | [Point correctness](g03-point-correctness.json): both native adapters, 32 forced parity/overflow cases and 47 boundary cases | Passed on current runtime |
| Near plane, inside sphere, projection/reverse/remapped depth, jitter, empty/background/extreme range, source mutation | Same current-source native matrix, including actual removal/re-addition | Passed |
| Same-frame local and total storage exhaustion without double count | Native capacity=2 / records=2 / records=0 modes and complete-image comparison | Passed |
| Source capacity rejects 1025 and recovers at 1024, strict and explicit Forward | Native source-capacity cases in current correctness evidence | Passed |
| Four-view isolation, resize, dynamic reuse and safe lifetime | Current native four-view checks plus source/tile lifecycle tests; old G02 source-bound reference evidence superseded by current-source rerun | Passed, including [current G02 reference regression](g03-point-reference-regression.json) |
| Optimized BRDF preserves complete source contribution | 30 added roughness/metallic compact/full-list comparisons plus original G02 artifact hash invariant | Passed; tolerances unchanged, not bit-exact |
| Frozen 128/256 sparse/overlap room on both devices, HDR/LDR | [Current eight-case room matrix](g03-final-room-matrix.json), matching runtime/harness hashes, full 720p pixels and 3,600-entry heatmaps | Passed; smoke timings excluded from performance qualification |
| Cull/resolve/full GPU span, CPU/queue/upload/allocation/memory/heatmaps and raw paired samples | [Final 24-capture review](g03-final-performance-review.md), all hashes/current fingerprints revalidated | Passed; all 32 CPU/GPU/lighting/frameWall stability channels pass |
| Sparse-256 ≥20% light-stage improvement; overlap-128 ≤10% extra whole-GPU cost or measured correct bypass | Final pooled 900 samples/path: sparse lighting −92.50%/−94.22%; overlap GPU −16.05%/−8.91% | Passed on both devices, including unchanged stability thresholds |
| Broader 60/30 FPS and full device qualification | ADR 0109 and [G02→G03 handoff](g03-handoff.md) assign final absolute performance/device qualification to G05/G07 | Handed to G05/G07 explicitly; high-overlap absolute GPU/frameWall gaps remain, no release performance claim |
| Repository typecheck/tests/build, API/docs/module/responsibility/prepare | `artifacts/engine-0.2.1/g03/point-checks/`: typecheck, 1,349 tests, 95 fresh examples and listed checks | Passed |
| Package and ordinary-consumer isolation | Current deterministic actual pack/install/browser/Node/TS/export/CLI check, archived in point-checks | Passed within existing budgets; no export/version changes |
| Shader generation consistency and cost | 417,394 B / 71 files / 63 variants/pipelines; user approved 418,480 / 71 / 63 and configuration was applied exactly | Passed: [application record](g03-budget-application.json), 10 policy tests and all four cap/cap+1 boundaries |
| Full Shader Language / Stage14 DAG | Complete `shader-language:check` and unchanged Stage14 DAG; all 25 nodes passed with one build per workspace | Passed; reports/logs archived in `approved-budget/` |
| Final evidence revalidation, G04 handoff and milestone close | [Final evidence audit](g03-final-evidence-audit.json) rechecks correctness, provenance, package/root checks and approved Shader admission; [G04 handoff](g04-handoff.md) accepted | Passed for G03 scope; G04 ready, not activated |

No failed capture is deleted or replaced with a passing retry. The additional same-pipeline diagnostic is explanatory, not a substitute for the independent three-cohort gate. No slower samples are dropped and no CPU/GPU threshold is widened.
