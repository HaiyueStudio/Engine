# G02 completion audit

Status: **complete**, 2026-09-26. G02 correctness and closing checks have passed. G03 is ready but not activated. G01 budgets and historical evidence remain frozen.

## Delivered scope

The private Deferred reference path consumes an untruncated immutable World light table, validates stable IDs/generations and device capacity, writes standard PBR opaque/mask G-buffers, reconstructs depth, and resolves the complete light list into linear HDR through the existing frame graph and output path. It serves as the correctness oracle for G03; it does not implement Tiled culling or public package activation.

The two final reliability items are addressed:

- **67→68 bind-group growth:** record slots now become reusable after all referencing encoders submit; actual GPU buffer destruction still waits for completion. Regression tests hold completion callbacks and protect shared unsubmitted encoders. See [resource reuse](g02-resource-reuse.md).
- **Intermittent four-view empty output:** explicit output viewport/scissor alone was insufficient. The generated final-output vertex shader now computes identical positions/UVs without indexed local arrays; fragment behavior and the other fourteen postprocess shaders are unchanged. See [investigation](g02-four-view-investigation.md). This is a tested compatibility mitigation; the exact native backend defect is not established.

## Source-bound native acceptance

[Final native validation](g02-final-native-validation.json) indexes all captures by SHA-256, runtime/harness fingerprints, adapter/browser identity and generation time. All final full/room captures use runtime fingerprint `0beca3099d61ccdbfdd5654c69d612765eb56350ccbe935bc1d90bf7ff26f0d9`.

| Check | Result |
| --- | --- |
| Independent full-reference launches | AMD RDNA-1 6/6; Intel Gen-9 3/3 |
| Named light counts | 0/1/8/9/32/128/256 on both adapters |
| Complete contribution oracle | All 256 individual lights have distinct stable IDs; HDR accumulated reference and 0/1/8 Forward parity pass |
| Materials and geometry | Texture/UV/sampler transforms, normal map, alpha mask, clipping, double-sided, environment/ambient-once, light mutation and vertex-color/auxiliary coverage pass |
| Reconstruction | Eight projection/depth combinations plus jitter pass |
| Dynamic reuse | Buffers 429→429, bind groups 67→67, pipelines 27→27; uploads 1→8; no new bind groups |
| Actual queue ordering | 32 submissions without intermediate awaits; all 128 copied words correct per run |
| Four views | 5,184 frames, 81 profile activations; shared source uploads once |
| Independent output probes | Both adapters: 512 clear + 512 shared HDR + 512 isolated HDR frames each |
| Fixed room | Both adapters: 1280×720, 256 boxes, 128/256 lights, sparse/overlap; full light coverage and inspected HDR/G-buffer panels |
| Validation and cleanup | No GPU validation errors; owner residual and tracked live GPU resources both zero |

Candidate runtime chunks and hashes are in `artifacts/engine-0.2.1/g02/fixture-build.json`. Final screenshots are `room-{high-performance,low-power}-final.png`; immutable detailed JSON is linked by the native validation index. This is development candidate evidence from a dirty worktree, not release or performance qualification.

## Static, build and regression checks

[Final serial validation](g02-completion-validation.json) records 1,340 passing repository tests (123 Shader Language, 711 Engine, 107 animation-spec, 392 extensions, 7 catalog), repository typecheck, 95 fresh build targets under the default timeout, API/docs/boundary checks, 131 performance-policy tests and seven Deferred policy/room tests. The complete Stage14 DAG passes all 25 nodes; SceneOutput passes all 17 cases with zero validation errors. Lab passes the original cross-backend pixel thresholds across the default and four sampling cases; the character example passes all five passes with zero silhouette mismatch. Shader generation consistency and the existing cost gate already pass: **397,427 WGSL bytes, 69 files, 61 variants/pipelines**, 151 fewer bytes than the preceding candidate. No budget or pixel threshold was widened for these fixes. The original HDR artifact contract is preserved; `output-vertex-compatibility-contract.json` records the new artifact hash and unchanged pass hashes.

## Retained failures and evidence boundaries

The earlier bind-group failure, all captured four-view failures, and the explicit-state-only recurrence remain archived. Five arithmetic shader-substitution launches passed; the sixth timed out at the eight-light case and is incomplete evidence, not a pass. Final acceptance uses the later nine production-source runs, not the substitution experiment.

Two initial submission-probe runs failed renderer metric classification because the diagnostic writes were included outside the renderer workload; moving the probe before audit installation fixed the harness without changing renderer populations or thresholds. Their failures remain archived.

The complete Stage14 chain also caught an outdated Stage10 deformation fixture: its UV1 slot still supplied a 36-byte buffer after the production layout became a 24-byte-per-vertex UV1/RGBA stream. The fixture now supplies three complete records with white vertex color for outline and motion draws, and reports draw validation errors directly. Production rendering and the Deferred native fixture already used the correct layout. The original pixel thresholds remain unchanged; the failed DAG report/log are retained in `artifacts/engine-0.2.1/g02/final-validation/stage14-stage10-old-stream-failure.*`.

One closing root-test run was invalidated by an accidentally concurrent Stage14 build deleting/rebuilding `dist`; it is retained as an orchestration failure. The repeated build chain was stopped, and the affected checks were rerun serially and passed. It is not treated as a production runtime failure or a successful test run.

## Handoff and remaining version work

[G03 integration handoff](g03-handoff.md) describes the source/view ABI, queue/retirement ownership, full-list oracle, same-frame overflow fallback and comparison matrix. Completion of G02 makes G03 ready; it does not activate it.

Broader material/transparent/postprocess/device-recovery compatibility and the 300-switch qualification matrix remain G04/G05/G07 work. Tiled performance, the discrete 60 FPS/integrated 30 FPS targets, public experimental exports, clean packages and release checks are not claimed here. No publish, tag, push, version change or G03 implementation is part of this closure.

## Final bundle-size correction

The complete Stage14 DAG exposed a previously missed deformation runtime artifact limit: gzip **9,607 > 9,600 bytes**. Compact serialization of the generated runtime metadata reduces it to **7,983 bytes** without changing WGSL, reflection, provenance, resource layouts or the artifact hash (`db2f01ef…`). An exact deep comparison of the built runtime artifact against the compiler artifact passed; evidence is `artifacts/engine-0.2.1/g02/compact-deformation-equivalence.json`. The generator remains the only writer of the artifact. No budget changed.

The final candidate's full checks and source-bound native captures were repeated and passed after this serialization change; earlier passing captures remain archived as `*-pre-compact.*`. Preliminary dead-source pruning experiments were not sufficient to address compressed size and were restored before selecting this lossless metadata change. They are not part of the final implementation.


Material-lighting and compute artifact limits were also checked and corrected without budget changes. Final gzip sizes are 12,852/15,000 and 4,500/4,500 respectively. The compute artifact has no remaining byte margin; this is a future growth constraint, not a waiver. See [artifact size correction](g02-bundle-optimization.md) for source-deduplication behavior, exact artifact equivalence and limits.
