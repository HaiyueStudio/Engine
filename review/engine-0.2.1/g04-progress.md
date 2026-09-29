# G04 rendering compatibility progress

2026-09-27. **Active; no completion or release qualification.** User explicitly activated `g04-rendering-compatibility`. Starting Engine revision: `5b07c271d05115762699b3d9f3fbb5e04310b95b` (clean at activation). G03 accepted evidence and [handoff](g04-handoff.md) remain the regression baseline, not evidence for new G04 features.

Current status (2026-09-28): **G04 complete; G05 ready, not activated.** See the [compatibility audit](g04-compatibility-audit.md), [current machine evidence](g04-native-compatibility-audit.json) and [G05 handoff](g05-handoff.md). The frozen AO contract is implemented and verified; earlier checkpoints below remain historical.

## Required outcomes and evidence

| Requirement | Current implementation gap / verification owner |
| --- | --- |
| Standard PBR mask, UV, vertex color, double-sided, clipping | Existing G02 surface; add current-source paired material pixels and A/B regressions |
| IOR/specular, clearcoat/normal, sheen | Current Deferred guard rejects extensions; implement proxy surface and full-table Forward PBR, preserve original layered BRDF and texture semantics |
| Transparent PBR with 128 complete lights | Connected; five material modes × five light counts × Reference/Tiled pass on AMD and Intel, compared against 128 independent original Forward renders per mode. Full temporal/multiview integration remains pending |
| Transmission/thickness/volume | Existing opaque HDR copy owner retained; textured transmission/thickness and attenuation, with/without clearcoat, pass the native transparent matrix. Broader effect/history integration remains pending |
| Morph/skin/CPU and external GPU instances, mirrored/nonuniform normals | Preserve shared deformation ABI across G-buffer, Forward, shadow and auxiliary passes; native pixel/identity coverage |
| Special renderers/helpers/materials | Explicit whole-view Forward or strict failure when compatible surface unavailable; visible capacity/coverage reason, never claim eight-light fallback as full coverage |
| Directional shadows, IBL, AO, fog, HDR output | Existing owners and one application of each effect; stage-specific native paired evidence; correct AO surface sequencing |
| TAA, motion blur, outline | Per-view histories and current/previous deformation semantics; dedicated temporal and foreground/background pixel cases |
| RTT/reflection child views | Independent profile/capacity diagnostics and resource/history ownership; native child/main and four-view evidence |
| Four views/layers/projections, resize/DPR/profile changes/view deletion | At least 300 lifecycle switches, bounded high-water resources and zero cleanup residue; preserve pending encoders and source sharing |
| Device replacement/loss and async initialization cancellation | Injected replacement separate from true native loss, no stale handles or late initialization resurrection |
| Existing gates and scope | Focused shader/renderer/lifecycle/browser checks, root typecheck/tests/build, effects gates/Stage14, provenance and cost review; G05/G07 absolute/release scope unchanged |

## Implementation sequence

1. Compile full-list Forward variants from the existing four PBR variants, replacing only light iteration and shadow-slot lookup. Keep frame/object/material/scene binding ownership and all BRDF/texture/deformation code.
2. Bind immutable complete source/view/index buffers through the private PBR port; render Forward-only opaque proxy surfaces and ordered transparent draws with shared depth and existing scene-color copy owner.
3. Integrate auxiliary surfaces/AO and effect history/lifecycle contracts, then execute the full C/D matrix and A/B regressions on the two named native adapters.
4. Run current-source repository/cost/package-isolation checks and audit every row before G04 completion or G05 readiness. New shader costs must be attributed; no budget silently changes.

## First checkpoint

Added a private Shader Language full-list PBR specialization and shared source adapter. It retains all four existing variants and every original material/deformation expression; only source iteration and directional shadow-slot addressing change. It uses complete per-view point indices and one aggregated ambient record, validates source generation/lengths, and never uses opaque tile lists. Two focused tests validate artifact reflection, complete original-source reconstruction and rejection of incompatible source/layout changes; workspace typecheck passes.

This first checkpoint was a compiler foundation. The runtime and evidence added afterward are described below; opaque extension admission remains guarded until its proxy surface is implemented.

## Transparent full-light checkpoint — 2026-09-27

Implemented the private full-source Forward path for sorted transparent PBR, including existing clearcoat, specular/IOR/sheen and transmission/volume material code. Source/view/index bindings remain immutable across pending submissions. The ordinary Forward import closure does not import the new shader family. The original material, vertex/deformation and BRDF expressions are preserved by source-reconstruction tests.

Two bugs were found and fixed during integration:

- The frame graph originally read and wrote the same scene resource version. Resolve now produces opaque color/depth versions; the transparent pass consumes those and produces final scene versions.
- The generated group-3 layout originally omitted the renderer's dynamic light-buffer offset at binding 0. Native validation exposed rejected transparent draws. Reflection now declares the dynamic binding, with a focused regression test.

`PbrSceneBindGroups` owns weak binding provenance; `Render3DScenePassRenderer` owns Deferred draw callbacks and the existing opaque HDR snapshot adapter. The orchestrator size budgets remain unchanged and pass. Full-light states/groups are bounded at 64/128; 300 cache-key changes are covered by a CPU structural test. **That test does not satisfy G04's separate 300 native view/lifecycle-switch requirement.**

### Native pixel evidence

The final capture uses actual texture-coordinate inputs and compares RGBA (RGB is the sum of independent lights; alpha is the original Forward compositing result). Each material mode has 128 independently rendered original Forward contributions. The fixture includes an opaque background, two differently colored/depth-sorted transparent foreground planes, and an occluded transparent plane.

| Adapter | Matrix | Maximum HDR channel error | GPU errors | Owner / live resource residue |
| --- | --- | --- | --- | --- |
| AMD RDNA 1 | 50/50 | 0.0002765655517578125 | 0 | 0 / 0 |
| Intel Gen 9 | 50/50 | 0.00015926361083984375 | 0 | 0 / 0 |

Matrix: standard, textured clearcoat, textured specular/sheen + IOR, textured transmission/thickness/volume, textured transmission + clearcoat; 0/1/8/9/128 lights; Reference and forced Tiled. This is correctness evidence at 64×64, not performance qualification.

Final captures after responsibility extraction:

- `artifacts/engine-0.2.1/g04/transparent-high-performance-passed-2026-09-27T12-14-33.315Z.json`
- `artifacts/engine-0.2.1/g04/transparent-low-power-passed-2026-09-27T12-14-39.843Z.json`

Both contain source/build/harness fingerprints, HTTP byte/hash provenance, dirty revision, named material/light cases, per-light contributions, frame-plan dependencies, native adapter identity and cleanup counts. Earlier failed captures remain diagnostic history. Two intermediate browser runs failed because of a closed DevTools connection/startup timeout; neither is counted as a passed capture. The original pre-reflection-fix GPU validation failure is also retained.

Reproduce with `node scripts/webgpu-gate/build-deferred-fixture.mjs --compatibility`, then `node scripts/webgpu-gate/run-deferred-compatibility.mjs` and the same command with `--integrated`. G04 runtime output is isolated from G02/G03 evidence directories. The importable fixture policy rejects missing/duplicate material/light cases, incomplete independent contributions, missing adapter/cleanup/errors and unversioned transparent dependencies.

### Shader cost admission remains open

The new family is registered in the migration inventory, production registry, aggregate generator and content-addressed cache. Its private contract is `shader-language/deferred-full-forward-extension-contract.json`. Deterministic generation and freshness are tested. Four static variants preserve the existing clearcoat/transmission branches and texture layouts.

- New family: **137,842 WGSL bytes / 4 files / 4 variants / 4 pipelines**.
- Current total: **555,236 bytes / 75 files / 67 variants / 67 pipelines**.
- Existing G03 limits: **418,480 bytes / 71 files / 63 variants / 63 pipelines**.
- The cost gate correctly fails both total and growth limits. No budget or exclusion was changed. The remaining G04 implementation must be included before a complete cost proposal is frozen.

### Remaining completion work

Opaque extension proxy surfaces/full-table shading, auxiliary/AO sequencing, shadows/IBL/fog and temporal/outline effects, deformed/external-GPU-instance compatibility, child RTT/reflection views, the native 300-switch lifecycle matrix, actual loss versus injected replacement, current-source A/B regressions and complete Stage14/cost/final audit remain required. This checkpoint does not close G04 or qualify a release. Current repository validation is recorded in the accompanying checkpoint report.

### Repository validation for this checkpoint

- Root `typecheck`, `test` and `build` passed: 1,354 tests (129 Shader Language, 719 Engine, 107 animation-spec, 392 extensions, 7 example catalog), with 95 fresh example targets.
- Module boundaries, responsibility budgets, synchronous prepare contract, public API and milestone repository checks passed.
- Performance gate policy tests: 134 passed; the initial sandbox invocation could not bind a localhost HTTP test server (`EPERM`), and the authorized local-server retry passed. The focused fixture policies also passed all 8 tests.
- Cost admission fails as documented above. Full Stage14/effect/native A/B acceptance is still pending the rest of G04.

The [machine-readable checkpoint](g04-transparent-checkpoint.json) records the exact current runtime fingerprint, both native captures, checksummed validation logs and outstanding scope. No commit, publish, version bump or budget change was performed.

## Shader budget and reuse follow-up — 2026-09-27

The user approved the [budget/import proposal](g04-budget-import-review.md). Current transparent full-list admission is now **570,000 bytes / 75 files / 67 variants / 67 pipelines**, with the historical growth baseline and cost population unchanged. Current measured cost is **555,236 bytes**, so the earlier checkpoint's cost failure is resolved for this implemented scope. The speculative full-G04 600,000-byte envelope was not applied.

The full Forward Artifact shares base strings and equal reflection fields. Actual standalone Rollup Artifact gzip fell from **31,297 to 10,484 bytes**; complete expanded WGSL and Artifact hashes remain identical. A registered build-time include frontend now assembles the nine common PBR modules, with transitive watch/cache inputs, cycle/path/conflict checks and build-only source provenance. It does not enter Engine runtime or expose raw source to Graph JSON.

The optimization passed 50 native material/light cases on each of AMD and Intel, with the same pixel error as the earlier checkpoint and zero validation errors/resource residue. The current Stage14 DAG passed all 25 nodes. Exact measurements, captures, repository validation and remaining scope are recorded in the [application report](g04-budget-import-application.md) and its [machine-readable evidence](g04-budget-import-application.json). This resolves this optimization task, not the remaining G04 compatibility matrix or release qualification.
