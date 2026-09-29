# G05 instance resource reuse and package checkpoint — 2026-09-28

Status: **diagnostic checkpoint; G05 remains active**. Native correctness and stable allocation counts pass. Full timing qualification is separate and incomplete. Machine-readable evidence and hashes: [checkpoint](g05-instance-cache-review.json).

## Resource optimization

`GpuInstanceBindings` previously retained only the most recent source binding for each entity. Four views use separate visibility buffers; switching views recreated the same bindings on every frame. The 10k/four-view/rejected-frustum diagnostic recorded 36 new bind groups over three CPU samples and another 36 over three GPU samples: 12 per frame in each population.

The cache now retains at most 16 variants per entity, keyed by transform/color/visibility buffers, visibility offset and capacity. Count changes do not rebuild bindings. The material uniform remains a single owned buffer. Entity release clears every variant; borrowed source buffers are not destroyed by this cache. Rebinding invalidates by revision and rebuilds only when a caller supplies a currently used source, avoiding access to retired buffers in unused variants.

The same workload now creates zero bind groups during both populations. All 32 diagnostic cases have zero newly created bind groups, buffers and pipelines in their measured frames. This is a structural improvement, not a qualified timing/FPS claim: the short captures used three samples per population and had reduced host CPU speed limits. The pixel oracle was strengthened between captures; their timings are not pooled.

Current runtime fingerprint: `43eaf828b7dc68a3f6e7bdd1e591bf71d07d6ad4f47b777ec54a9ae5fe5c5baf`. Historical runtime bundles remain under `artifacts/engine-0.2.1/g05/runtime-*/`. The initial G05 statement that runtime was unchanged from G04 describes the earlier checkpoint only.

## Native correctness and regression

- Complete diagnostic matrix: 1k/10k × one/four views × LOD on/off/visible frustum/rejected frustum × AMD/Intel = 32 captures.
- 80 per-view pixel comparisons have maximum delta zero. Frustum cases compare directly against the unculled all-high-quality output; LOD cases compare against independent CPU-selected LOD buckets.
- Every returned instance ID is checked against the CPU sphere/LOD classifier after timed frames. Normal frames perform no full-instance readback.
- Nine independent baked-position/inverse-transpose-normal probes per case include four mirrored and nine nonuniform transforms; maximum delta zero.
- Geometry tiers are explicitly 144/64/16 triangles. LOD timing comparisons change geometric detail and cannot be described as equal-quality acceleration.
- Zero WebGPU validation errors and zero owner/live-resource cleanup residue in all 32 cases.
- Current-runtime G04 instance compatibility passes on both native GPUs: CPU/external GPU, full-light reference/tiled and explicit whole-view Forward fallback. Legacy 10k GPU instance/Toon/normal verifier also passes.

Artifacts: final matrix `instance-smoke-matrix-2026-09-28T00-25-35.596Z.json`; G04 regressions `g04-instance-regression-*-passed-2026-09-28T00-28-*.json`; legacy regression `legacy-instance-regression-2026-09-28T00-29-47.315Z.json`, all in `artifacts/engine-0.2.1/g05/`. Earlier failed development captures and the earlier weaker matrix remain preserved.

## Package consumer correction

The first real-tarball check failed because Engine contained 625 files, above the unchanged limit of 620. The six additional G04 declarations exposed an existing packaging inefficiency: private declarations unreachable from any public type entry were still shipped.

Engine build and prepack now use the repository's existing declaration graph pruning tool. It retains the full transitive closure of all public type entries and removes 127 unreachable declarations. No public exports, package version, dependency ranges, runtime JS or budgets change due to this pruning.

| Current package measurement | Observed | Existing limit |
| --- | ---: | ---: |
| Engine files | 498 | 620 |
| Packed bytes | 1,831,454 | 2,100,000 |
| Unpacked bytes | 7,598,548 | 9,000,000 |
| GPU instance consumer gzip bytes | 80,457 | 91,000 |

The real npm tarball/install gate passes deterministic packing, browser bundles, Node, CLI, export/provenance and TypeScript checks. TypeScript now explicitly imports all **37 Engine public type entrypoints** with `skipLibCheck: false`. The failed candidate is archived at `package-2026-09-28T00-30-37.486Z/`; the passing candidate is at `package-2026-09-28T00-37-52.526Z/`. Historical release reports/tarballs were restored after each diagnostic; this does not promote a release baseline.

## Checks

Logs: `artifacts/engine-0.2.1/g05/checks/instance-cache-2026-09-28/`.

- Four focused binding tests pass, including 300 four-view cycles, bounded eviction, lazy rebinding of borrowed buffers and release. The pre-fix failure log is retained.
- Engine and repository typechecks pass; 1,371 repository tests pass; all 95 examples build fresh. The final cache change is included. Package-only build/prepack hooks were verified afterward through the real tarball gate.
- 157 performance policy tests pass after adding the full-cohort and stability checks (151 at the earlier native matrix checkpoint).
- API/workspace graph, 483-module boundary/cycle check, responsibility contracts, synchronous prepare check, declaration graph tests and milestone check pass.

## Full F qualification pipeline

`node scripts/webgpu-gate/run-deferred-g05-instance-cohorts.mjs --plan` lists all 96 captures. `--full` runs three counterbalanced cohorts on both GPUs, with 120-second idle, 120 warmup frames and separate 300-sample CPU/GPU populations for each paired path. Minimum idle time alone is 192 minutes.

The validator requires exact coverage/order, native frozen adapters, ready pre/post host state, matching runtime/harness/revision and stable resources. It pools all 900 samples per path using nearest-rank P95 and applies the frozen F CPU/GPU/untimestamped wall budgets to the candidate. Reference timing is reported separately. Missing/slow samples cannot be discarded, and G01's special sub-millisecond variance exceptions are not applied to these new workloads. A failure stops the attempt with its raw evidence retained.

After capture, `node scripts/webgpu-gate/audit-deferred-g05-cohorts.mjs --instances=<manifest.json>` is mandatory for final F timing acceptance (`--rooms=<manifest.json>` for E/G). This independent audit verifies the raw artifact/manifest identity and frozen configuration, re-evaluates the pooled budgets, and checks every paired CPU/GPU/frameWall channel for three-cohort stability. It uses the existing G01 limits: relative spread ≤20% and CV ≤10%; no fixture-specific absolute-ceiling exceptions. A fast pooled P95 cannot hide cohort drift. The audit emits a new hash-bound artifact and does not promote release evidence.

Remaining G05 work: qualified F and E/G cohorts; default Forward regression; high-overlap resolve cost; low-limit/capacity and attributed memory evidence; cold compilation/AO costs and final audit. No claim of G05 completion or release readiness is made.
