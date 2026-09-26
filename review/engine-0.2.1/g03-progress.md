# G03 implementation and acceptance

Status: **active**, 2026-09-26. User activated G03 after G02 completion. No G04–G07 activation or release action is included.

## Frozen scope

Use ADR 0109 and `config/lighting-performance-021.json`: 16×16 tiles, 64 compute invocations, 16-byte header plus 128 u32 local indices (528 bytes/tile). Source indices retain source generation and local-point meaning. Each view owns its tile output; no opaque-depth truncation. Local or total storage exhaustion uses the complete view list in the same frame. Preserve the G02 full-list reference and its shared G-buffer/material semantics.

The compute implementation uses homogeneous clip-plane/sphere rejection with a conservative numerical margin. Ordered workgroup compaction preserves input light order. Fixed tile records avoid a global atomic allocator; a capacity-restricted diagnostic buffer explicitly exercises full-list fallback for tile records that cannot be stored. Partial prefixes must never be combined with full-list fallback.

## Acceptance checklist (all pending unless linked evidence says otherwise)

- Generated cull/resolve shaders, ABI/reflection, limits and bounded resource lifecycle; unchanged G02 reference.
- Per-view isolation, resize, source mutation/generation, device limits and pending encoder destruction tests.
- Independent CPU geometric oracle and real GPU tile readback: no false negatives; boundary/near-plane/inside-sphere/orthographic/reverse-Z/jitter/extreme-range/empty/background cases.
- Full B matrix, 128/256 sparse/overlap HDR and LDR parity; forced local and total-capacity overflow; no GPU validation errors.
- Heatmap/index-reference statistics, memory, original samples and same-frame fallback decisions.
- Paired cull/resolve/whole-frame GPU and CPU/upload/resource measurements under frozen protocol; sparse-256 ≥20% light-stage improvement and overlap-128 ≤10% full-frame overhead (or measured correct fallback), with both device classes.
- Focused then full tests/typecheck/build, generated consistency and cost admission, native regression, evidence audit and G04 handoff.

G02 evidence is historical once runtime sources change. New captures must bind current inputs; no earlier pass is promoted to G03 acceptance.

## Initial correctness checkpoint

The [initial source-bound cohort](g03-initial-correctness.json) passes on AMD RDNA-1 and Intel Gen-9: each has 32 HDR/LDR parity cases, 16 projection/geometry/mutation boundary cases, four isolated mixed-size views and partial-edge resize. The independent oracle uses closest distance to a triangulated closed frustum, not the production homogeneous plane rejection. Missing tile records and local prefix overflow both take full-list fallback. Each adapter has zero validation errors and zero tracked cleanup residue. Eight dynamic frames create no new buffers/bind groups/render pipelines after warmup.

Focused source/lifecycle, oracle/policy and generator tests, Engine/Shader Language typechecks and ownership checks pass; logs are in `artifacts/engine-0.2.1/g03/initial-checks/`. The unchanged G02 reference artifact hash is asserted by generator tests. Native first attempts caught a missing FogUniforms declaration in the compute module and fixture initialization statistics being included in frame metrics; both are fixed and failed captures remain archived. The first G03 bundle build used G02's TypeScript output directory and failed; the builder now explicitly routes both compiler and Rollup outputs to G03 when `--tiled` is selected.

The production cost gate currently **fails** at 415,106 WGSL bytes / 71 files / 63 variants and pipelines, against 400,801 / 69 / 61. The two Tiled passes contribute 17,679 bytes. No budget was changed. Cost admission remains pending; this initial checkpoint is not G03 completion. Full frozen room, performance, source-capacity native diagnosis, additional source add/remove and final repository checks remain to be completed. Subsequent source changes supersede this initial cohort rather than rewriting its evidence.

## High-overlap selection and expanded checks

A 120-warmup/300-sample AMD pair confirmed that always using Tiled in the high-overlap 128-light room costs 17.324776 ms GPU-span P95 versus 12.383291 ms for Reference (+39.9%). Raw captures are `room-tiled-128-overlap-high-performance-2026-09-26T06-38-41.757Z.json` and `room-reference-128-overlap-high-performance-2026-09-26T06-39-20.931Z.json` under the G03 artifact directory. This is a single diagnostic pair, not the final three-cohort population.

`DeferredTileSelection` now uses the full-list reference pipeline when every point-light sphere strictly contains all four reconstructed near-plane corners. A convex sphere containing that quad intersects every tile; culling cannot shorten any list. Uncertain arithmetic retains normal culling. The fallback records `all-lights-cover-near-plane`, preserves complete coverage, and skips tile compute/storage for an initially bypassed view. Forced-culling fixtures continue to exercise actual GPU local/total overflow. Empty source also uses the reference path. Four-view transitions between both paths pass on AMD and Intel.

The native matrix now includes actual source removal/addition, compute-pipeline allocation counters, and source-capacity rejection under strict/explicit-forward policies with recovery from 1025 to 1024 lights. Both adapters passed these checks before the subsequent timestamp-module extraction. The earlier fixture instrumentation attempted to overwrite a read-only tracked device method; it now reads the existing resource tracker's cumulative compute-pipeline count. The failed capture remains archived.

Repository typecheck and all 1,348 tests pass (125 Shader Language, 717 Engine, 107 animation-spec, 392 extensions, 7 catalog). The full build completes 95 fresh example targets. API/docs/module checks pass. The responsibility gate found the benchmark orchestrator at 1,255 lines against 1,250; GPU timestamp ownership was extracted to `real-renderer-gpu-timestamp.mjs`, preserving the default render-only population and opt-in compute/span metrics. Responsibility/prepare checks and 13 timestamp/scenario tests then pass. Current-source native recapture and three interleaved performance cohorts remain pending. No cost budget is changed.

## Current-source checkpoint and remaining failures

[Current correctness](g03-current-correctness.json) now validates the post-extraction runtime on both native adapters: 32 parity/overflow cases, 17 boundary cases, four views/resize/automatic transitions, strict/forward source-capacity cases, zero validation errors and cleanup residue. All eight frozen-room combinations have identical HDR/LDR output. The package gate passes all actual consumers with Engine 1,895,289 B packed / 8,286,038 B unpacked / 619 files; root consumer remains 48,221 B gzip. No package budget increase is needed.

[Three-cohort performance review](g03-performance-review.md) and its [machine evidence](g03-performance-review.json) retain all 24 captures / 7,200 timed samples. Sparse-256 passes both relative and absolute budgets on both devices. High-overlap-128 fails AMD's relative GPU limit (+12.6%) and both devices' absolute GPU/frame-wall limits. All measured cohort channels pass the frozen stability test. A separate same-pipeline paired diagnostic narrows the observed GPU gap to approximately 1.7%, but does not establish a root cause or replace the failed independent population.

G03 remains active. The [Shader cost proposal](g03-budget-review.md) is prepared and its boundary simulation passes, but configuration is unchanged pending confirmation. Full Stage14 DAG is not rerun past the known cost admission failure. G02 reference regression is being rerun on the current runtime; G04 remains inactive.

The current-runtime [G02 reference regression](g03-reference-regression.json) subsequently passes on both native devices, including independent single-light accumulation, material/vertex coverage, projection combinations, four-view source/resource reuse and submitted-arena ordering. The 12 Tiled cohort/bypass/room/oracle policy tests pass; raw failures and successful recaptures remain separate. There is no remaining correctness regression observed in this checkpoint. Performance/admission failures above remain open; G03 is not complete and G04 is not activated.

## Point-loop optimization in progress

The subsequent [point-light optimization](g03-point-optimization.md) preserves the original G02 reference and two-pass Tiled family, hoists pixel invariants, reads only needed point fields, and evaluates provably zero contributions early. High-overlap compute bypass now executes the optimized full-list branch, using a 4-byte sentinel binding; it no longer selects the old reference pipeline. The earlier checkpoint links above are historical for this new runtime.

Both adapters pass the expanded 32 + 47-case native matrix and source/view lifetime checks. A new full AMD pilot pair is promising, but Intel's after-capture CPU speed limit of 84 invalidates that performance attempt. Repository checks and a fresh three-cohort qualification are pending. G03 remains active; no Shader/package/performance budget was changed.

The point optimization now passes repository typecheck, 1,349 tests, all 95 fresh example builds, API/docs/module/responsibility/prepare checks, and the actual package/consumer gate (Engine 1,895,285 B packed / 8,286,100 B unpacked / 619 files). Source-bound native evidence is [point correctness](g03-point-correctness.json). Total WGSL is 417,394 B; the previously proposed 418,480 B cap still suffices with 1,086 B reserve, but remains unapplied. The [working completion audit](g03-completion-audit.md) explicitly tracks every remaining gate. New current-runtime G02/room/cohort captures are running; the earlier results cannot close this version of G03.

## Point-cohort audit and full repeat protocol

The [current point performance review](g03-point-performance-review.md) validates all 24 source-bound captures and the [eight-case room matrix](g03-point-room-matrix.json). All four relative performance comparisons pass. AMD sparse Tiled GPU-span and lighting P95 fail cohort stability (26.25%/23.45% spread and 11.36%/10.25% CV); the other measured cohort channels pass. High-overlap absolute GPU/frame-wall gaps remain assigned to G05/G07. No results or thresholds are replaced.

All 13 independent Stage 2–14 browser leaf checks passed against the current root-build outputs; evidence is `artifacts/engine-0.2.1/g03/point-checks/browser-leaves.json`. This is partial regression coverage, not an approved full Stage14 DAG: the unchanged Shader cost gate still rejects production generation. Updated docs checks and `git diff --check` passed.

Before viewing repeat results, the next sampling plan is fixed: rerun the entire same 24-capture plan once, with unchanged source, harness, 30-second minimum idle, 120 warmup / 300 samples, interleaved order and stability policy. Retain the first complete population and report the repeat separately; never splice a fast repeat into the first population. The reason is the short multi-pass slowdown in AMD sparse cohort 3; its cause remains unproven. No user process is stopped. No builds/tests or runtime/harness edits run during the repeat. G03 stays active, the Shader proposal remains pending, and G04 remains inactive.

The repeat process exited with status 1 at capture 4: preflight reported CPU speed reduced or unavailable. [Repeat status](g03-point-repeat-status.json) preserves three complete captures and the rejection log; no complete cohort report exists. The rejected raw pmset value was not retained, so its exact value is unknown. Follow-up at 08:59:29 UTC returned speed/scheduler=100. Do not relabel the incomplete repeat as a pass or merge it with the previous population. Immediate repeated attempts stop pending an adequately idle host window; stability and Shader admission remain unresolved. This is an observed external sampling failure, not evidence of a new rendering defect.

## Approved Shader budget applied

The user confirmed “shader预算提案可行”. The exact proposed production caps are now applied: 418,480 bytes / 71 files / 63 variants and pipelines, with unchanged historical baseline and corresponding maxGrowth 112,976 / 7 / 7 / 7. Package, performance, cold-generation and consumer budgets are unchanged.

[Application evidence](g03-budget-application.json) records the original proposal hash, before/after configuration, 10 passing policy tests, complete Shader Language check, all 25 passing Stage14 DAG nodes and cap/cap+1 checks for each changed metric. Current production remains 417,394 bytes with 1,086 bytes spare. Reports/logs are archived under `artifacts/engine-0.2.1/g03/approved-budget/`. Runtime/harness fingerprints still match existing performance evidence. Shader admission is resolved; the two AMD sparse stability failures and final G03 closing audit remain open. G04 is not activated.

## User-requested final stability recapture

The user requested completion of both stability retests and the closing audit. Before the new complete 24-capture run, the room CLI gained one preflight log containing the raw host observation before possible rejection. Six room/cohort policy tests and the fixed plan command pass. Rendering, sampling, thresholds and runtime inputs are unchanged; the room harness fingerprint changes because its CLI now records the previously missing rejected observation. Earlier room/campaign evidence remains historical under its original harness hash, while native correctness and G02 regression fingerprints are unaffected.

The new run uses the full original three-cohort protocol, retains old failures and will not splice populations. No builds/tests or further runtime/harness edits run concurrently. Completion remains unproven until the entire run and closing evidence audit pass.

The new run stopped at capture 7 after Intel high-overlap reference sampling: host CPU speed limit was 100 before and 53 after. Pixel validation passed, but performance qualification correctly rejects this capture. Six accepted captures and the complete rejected raw capture remain in `cohorts-2026-09-26T09-31-37.647Z` and its referenced room artifacts. No partial population is promoted.

The [final evidence audit](g03-final-evidence-audit.json) revalidates current native correctness/G02 fingerprints, eight room cases (with the CLI-only preflight-log change explicitly checked), approved Shader admission, 25 Stage14 nodes and archived root/package checks. A quiet/cooldown window has been requested from the user before further sampling. The two stability failures are still open; the goal and handoff are not marked complete.
