# G05 progress — 2026-09-28

Status: **active**. G04 is complete; G05 E/F/G performance qualification is not complete. G06/G07 are not activated. No release, revision or frozen budget changes are implied.

## Baseline and measurement correction

- Preserve the [G04 handoff](g05-handoff.md), accepted AO semantics and complete-light coverage.
- The G03 room runner measured `frameWallMs` after GPU timestamp readback. Its historical wall samples cannot establish the G05 untimestamped whole-frame budget.
- New G05 room capture replays identical frames in separate CPU and GPU populations. CPU frames have no timestamp probe or readback. GPU frames retain full compute/render span and every pass duration. Diagnostic pixel readback runs after timing.
- Cold initialization and first frame are retained separately. Full candidates use 120 warmup frames before each population and 300 samples per population, 120-second inter-case idle, native timestamp support and speed/scheduler 100 before/after.
- Per-view HDR is captured at the output boundary before shared scene texture reuse; all final view targets are independent. Pixel comparison retains the frozen absolute/relative HDR tolerance and LDR tolerance.
- Smoke captures are diagnostic only; no single short capture is performance qualification. All artifacts are uniquely named and carry runtime/build/harness hashes, dirty/revision, host checks and HTTP provenance.

## Required coverage

| Requirement | Status / remaining work |
| --- | --- |
| E six named room cases, reference/tiled, both GPUs | All 52 E/G native short captures pass on both GPUs; complete full qualification pending |
| E static/dynamic and 1-light supplementary coverage | Static and 1-light cases implemented; complete paired qualification still required |
| Forward default small-scene ≤5% CPU/GPU regression; zero Deferred allocations | Complete 12-capture native regression and independent raw-file audit pass; all eight budget/stability checks pass |
| Sparse-256 ≥20% cull+lighting benefit; overlap ≤10% overhead | Three-cohort plan/validator implemented; complete native evidence pending |
| Absolute CPU/GPU/untimestamped frameWall budgets | Pending; historical overlap GPU cost remains unresolved |
| F 1k/10k × one/four views × LOD on/off and visible/rejected frustum | All 32 native diagnostic cases pass; 96-capture full cohort runner/validator implemented; qualified timing pending |
| G 512/1024 overlap 1080p; low limits/capacity | Both GPUs pass 512/1024-light 1080p short correctness/resource checks and current-runtime source/tile capacity gates; full cost/physical low-limit evidence pending |
| Stable resources, static upload reuse, allocations/high water | Four-view bind groups 12/frame → zero; 52 native steady memory captures pass; native four-view/two-generation GPU readback and retirement pass; AO/auxiliary costs tracked separately |
| Cold compilation, AO cost, package consumer and shader budgets | Cold first-frame capture implemented; real tarball/all 37 public type entries pass after unreachable declaration pruning; 16 native cold/AO diagnostic captures pass; qualified cost timing remains separate |
| Current-source correctness after optimization | Instance cache optimized; current-runtime G04 instance regressions pass on both GPUs, legacy instance verifier passes |
| Formal clean-source release qualification | G07; dirty-tree candidates are not formal release evidence |

## Entrypoints

```sh
node --test scripts/webgpu-gate/deferred-g05-policy.test.mjs scripts/webgpu-gate/deferred-fixture-policy.test.mjs
node scripts/webgpu-gate/build-deferred-fixture.mjs --performance
node scripts/webgpu-gate/run-deferred-g05-room.mjs --case=overlap-128
# --integrated selects native low-power GPU; --reference selects the complete-light reference.
# --full creates a performance candidate, not automatic cohort/budget acceptance.
```

Artifacts: `artifacts/engine-0.2.1/g05/`. Frozen requirements: M18 `integration.md` E/F/G and `config/lighting-performance-021.json`.

## Initial implementation checkpoint

- Added isolated `--performance` fixture build output, strict room parsing/validation, independent CPU/GPU timing, per-view HDR/LDR readback, source-upload counters, cold initialization and resource snapshots. Production Engine runtime is unchanged from the G04 fingerprint.
- Added the 1-light supplement, static 1/8/128/256 workloads, and a three-cohort counterbalanced plan: 13 room workloads × two paths × two adapters × three cohorts = 156 captures. `run-deferred-g05-cohorts.mjs --plan` previews it. Required idle alone is 312 minutes; this is E/G room coverage, not the full G05 F/default-Forward suite.
- Full host rejection is retained as a failed artifact before rendering. Cohort validation rejects incomplete/mixed input populations, unstable GPU allocations, missing shared source uploads, and speed/scheduler below 100. Budget evaluation pools all equal-sized cohorts and reads unchanged G01 absolute and relative limits; stress has no invented FPS gate.
- [Smoke index](g05-smoke-index.json): seven native diagnostic captures, 13 per-view pixel comparisons. AMD/Intel overlap-128 and four-view checks passed; AMD static sparse-256 and reference single-1 passed; Intel 1024-light/1080p overlap passed. No validation errors or cleanup residue. Each capture has three CPU and three GPU samples, which is insufficient for performance qualification.
- Static sparse-256 lifetime source uploads remained at one before/after both populations; neither source nor view light-table data was re-uploaded during the sampled frames. Camera motion still updates the scene frame normally.
- The smoke harness evolved during these captures. Their recorded HTTP file hashes match each capture's declared build/harness hashes, and all runtime chunk hashes were rechecked. Different harness hashes are preserved; they are not merged into a cohort.
- Checks: 13 focused policy tests, 146 performance policy tests, milestone repository policy, script syntax and `git diff --check` passed. The first performance-policy attempt hit two sandbox-local HTTP `listen EPERM` errors; the full suite passed when rerun with local-port access. Logs and the room plan are under `artifacts/engine-0.2.1/g05/checks/`.
- Host readiness prevented performance acceptance: pre-capture CPU speed limits ranged from 31 to 86, scheduler 100. Read-only process inspection showed concurrent Swift/Clang compilation and browser/WindowServer load. No other task/process was stopped. Preserve the user's preference to let other work finish naturally.
- Remaining: qualifying full cohorts; high-overlap resolve cost and any evidence-driven runtime optimization; F instance/LOD/frustum paired fixture and correctness; Forward regression; low-limit/capacity stress evidence; attributed memory, AO/cold/package cost and final audit. G05 remains **active**, not complete.

## Instance/cache/package checkpoint — 2026-09-28

[Detailed audit](g05-instance-cache-review.md) and [hash-bound checkpoint](g05-instance-cache-review.json) record the new runtime change, 32-case native matrix, 80 pixel checks, independent pose/normal oracle and package results. Four-view instance bindings now retain a bounded set of per-view variants: new bind groups fell from 12/frame to zero without pixel changes. Both native G04 instance regressions and the legacy verifier pass.

Engine packaging now removes only declarations unreachable from the public type graph, reducing 625 files to 498 under the unchanged 620 limit. Real installation checks all 37 public Engine type entrypoints. The first failing package artifact and the passing artifact are both retained; release evidence was not promoted.

The F full runner and pooled budget evaluator are implemented: 96 paired captures, three cohorts, both GPUs, all count/view/LOD/frustum axes. `run-deferred-g05-instance-cohorts.mjs --plan` is read-only; `--full` enforces host qualification and keeps failures. Native smoke results are not performance acceptance. The complete E/F/G, Forward, memory and cold/AO obligations remain open.

Final cohort timing acceptance also requires `audit-deferred-g05-cohorts.mjs` for raw evidence integrity and G01 three-cohort stability (relative spread ≤20%, CV ≤10%). The new audit retains CPU/GPU/frameWall channels for both paired paths and never applies the G01-only sub-millisecond exceptions. All 157 performance policy tests pass.

Full F attempt started at `2026-09-28T00:45:06.765Z`: `artifacts/engine-0.2.1/g05/instance-cohorts-2026-09-28T00-45-06.765Z.json`. Read the live manifest for status and exact coverage; do not infer completion from this launch note. The first qualified captures passed host pre/post checks. Final independent stability audit is still required after the entire 96-capture attempt.

## Default Forward qualification preparation — 2026-09-28

The instance full attempt remains running; the session was polled live before this checkpoint. No second GPU suite is launched concurrently. `run-deferred-g05-forward.mjs --plan` lists 12 mandatory captures: frozen G01 `forward-small-1`/`forward-cap-8`, both native adapters and three cohorts. No argument runs four diagnostic smoke captures; `--full` runs the full matrix. The runner builds Engine once before cooling, fingerprints source/served dist and harness, checks the original frozen raw baseline file hashes, and preserves all failed captures.

The Forward fixture retains the G01 workload and exact CPU/GPU replay/timing code; additions observe resource/shader creation during setup and attach the resulting labels after timing. Native execution must prove zero Deferred allocations and zero cleanup residue. The pure evaluator uses all 900 CPU/GPU samples per device/case, unchanged ≤5% regression budgets and G01 relative stability limits. The 8-local-light legacy case keeps its known Forward capacity boundary and is not used to claim complete-light Deferred speedup.

Five focused Forward policy/audit tests pass, including missing/changed baseline, input mixing, throttling, Deferred allocation, retained slow tails and three-cohort drift. All 162 performance policy tests pass. Code/plan/log hashes are under `artifacts/engine-0.2.1/g05/checks/forward-2026-09-28/`. This is prepared infrastructure, not native performance acceptance; run smoke and full sequentially after the active instance attempt. Memory/high-water/capacity and cold/AO attribution remain required.

## Resource attribution and capacity checkpoint — 2026-09-28

[Memory review](g05-memory-review.md) records eight actual-renderer/shared-audit-device allocation checks and the four-view/two-pending-generation resource test. These are structural results, not native memory/performance qualification. Full G05 room captures now retain all live buffer/texture records by owner/category/view at warm/CPU/GPU boundaries, cross-check summed bytes against the shared tracker, and gate conservative per-view/total estimates against the unchanged budget. Old room smoke artifacts remain historical and cannot establish the newly required attributed-memory acceptance.

The structural pending-generation test retains 494,917,952 bytes of G-buffer/tile storage across four views, below the 536,870,912-byte target ceiling. Third-generation/fifth-view requests fail before allocating resources; referenced resources survive owner destruction until submission and are fully released after completion. It does not test native driver allocation, AO, or all other in-flight resource owners. The E/G full matrix remains 156 captures. All 165 performance policy tests pass; logs and failed harness-setup attempts are preserved under `artifacts/engine-0.2.1/g05/checks/memory-2026-09-28/`.

## First F cohort observation — 2026-09-28

The active attempt has completed the AMD 10k/single-view visible-frustum capture: `instances-10000-1v-frustum-visible-high-performance-2026-09-28T01-08-48.064Z.json`. Its first-cohort CPU/GPU/untimestamped frame-wall P95 values are approximately 0.310/2.392/21.580 ms; wall time exceeds the 16.667 ms single-view ceiling in this individual cohort. This is not the three-cohort pooled verdict, and the complete raw population is retained. All finished captures so far pass pre/post host and correctness/resource checks. The subsequent 10k/four-view LOD-on capture also passes correctness; full timing/stability acceptance remains open.

Operator activity: local Node policy and structural checks ran during the early part of this attempt while native captures were ongoing between cooling intervals. Host speed/scheduler snapshots remained 100, but these snapshots do not establish a contention-free interval. Keep this context when reviewing whole-frame/queue-wait variance; do not discard affected samples or attribute wall time solely to GPU execution. Further construction/check jobs are deferred while this attempt samples.

## First F full attempt stopped — 2026-09-28 01:17:59 UTC

The live process exited with code 1 after capture 15/96. The final raw renderer result passed pixel/ID/cleanup checks, but its post-capture CPU speed limit was 82 (pre-capture 100; scheduler 100). The complete manifest is `instance-cohorts-2026-09-28T00-45-06.765Z.json`, now terminal **failed**. Its 15 raw captures and full log (`checks/instance-attempt-1/full.log`) are retained; they do not establish F qualification and will not be spliced into a later attempt. No background full F process remains from this attempt. Continue serial native smoke/resource work, then a fresh full attempt only with a ready host.

## Native resource/capacity checkpoint — 2026-09-28

[Native resource audit](g05-native-resource-checkpoint.md) and [hash-bound index](g05-native-resource-checkpoint.json) retain 52/52 E/G room smoke captures, 64 per-view pixel comparisons, 104 source-upload/counter populations and four default Forward native smoke captures. All pass correctness, recorded allocation budgets and cleanup; all 16 static room captures avoid sampled source reuploads, and 36 moving captures upload the shared source once per sampled frame. These short captures remain unqualified for timing because host limits were reduced.

Current-runtime A/B core regression also passes on both GPUs: seven reference light-count cases and 32 tiled cases per GPU, including 47 culling/BRDF boundaries, multiview reuse, forced local/total/no-storage overflow and strict/Forward 1025-light rejection with 1024-light recovery. Physical reduced-device-limit probes and native pending-generation memory are still separate obligations.

The first F full attempt is terminal failed (15 captures, post-host speed 82); no F, Forward or E/G full process is currently active. Native smoke/core processes have also completed. Read-only process inspection during the diagnostic interval observed high-CPU `npm ci` and `npm ls` processes; they had already ended by the follow-up PID read. This observation does not establish the cause of the earlier F failure. Preserve the user preference to let other tasks finish naturally before a new full attempt.

## Native pending resources and cold/AO attribution — 2026-09-28

[Lifecycle/cost audit](g05-lifecycle-cost-checkpoint.md) and [hash-bound index](g05-lifecycle-cost-checkpoint.json) add passing native AMD/Intel four-view/two-generation GPU readbacks, pre-submit owner destruction protection, bounded 494,917,952-byte allocation and complete retirement. All 16 AO/cold short captures pass pixel/cleanup/resource checks; exact module hashes/bytes, pipeline links, first-use and per-pass timing are retained. AO visibility storage adds 14.06 MiB at 720p; total tracked resource growth is larger and explicitly reported. These short samples do not qualify performance. All 173 policy tests pass.

Seven lowered-limit requests per GPU return the WebGPU default floors, so physical below-requirement rejection is explicitly unavailable, never a passed claim. Injected guards and native default-limit/capacity coverage remain distinct. This platform fact must not be turned into an invented weak-device support claim. Failed attempts are preserved.

At this checkpoint all diagnostic processes are terminal; the main runtime fingerprint is unchanged. Next is the complete default Forward regression on a ready, cooled host, followed by remaining E/F/G and final audit. Read the live full-run manifest/session before inferring later status.

## Default Forward full qualification passed — 2026-09-28 02:17 UTC

The complete 12-capture run `forward-cohorts-2026-09-28T01-51-47.415Z.json` is terminal **passed**. [Qualification review](g05-forward-qualification.md) and [independent raw-file audit](g05-forward-qualification.json) retain 3,600 CPU/3,600 GPU samples and verify raw hashes, frozen baseline, current source/dist, all eight budget/stability checks and all 24 qualified host snapshots. Largest regression is Intel 8-light CPU +4.39%, below 5%; all captures have zero Deferred creation and zero cleanup residue. No concurrent build/test/GPU suite ran during this full attempt. Its process has exited; do not poll or restart session 89620.

G05 remains active: E/G and F full matrices, CPU object allocation attribution, high-overlap performance and final audit are not complete. Low-limit unavailability is a platform coverage statement, not a passed weak-device claim.

## 1080p AO memory budget failure confirmed — 2026-09-28 02:32 UTC

[AO memory review](g05-ao-memory-budget-review.md) and [raw evidence index](g05-ao-memory-budget-review.json) retain matching AMD/Intel failures: high-quality full-resolution GTAO on the frozen 1080p/128-light room allocates 95,832,328 Deferred bytes versus the 67,108,864-byte per-view limit. Pixels and cleanup pass; the budget does not. The 720p cost checkpoint and G-buffer/tile-only pending test do not cover this combination. R16F packing alone projects 70,949,128 bytes and therefore cannot be called a complete fix; the next step is joint AO/tile planning and bounded pending ownership under unchanged budgets and semantics.

The resource optimization is not implemented yet. No new full E/F/G attempt was launched on this known-failing candidate. All native/policy processes in this checkpoint are terminal; 174 policy tests and `git diff --check` pass. The full Forward qualification remains valid for the unchanged runtime fingerprint. G05 stays active; no release or Goal completion is claimed.

## R16F AO repair and allocation attribution — 2026-09-28 03:46 UTC

[Current checkpoint](g05-r16-checkpoint.md) and [hash-bound evidence](g05-r16-checkpoint.json) supersede the earlier “not implemented” observation for runtime `ce94c512…`. R16F visibility, joint AO/tile planning and shared pending-resource accounting now pass both native GPUs: 1080p GTAO Deferred allocation falls from 91.39 to 63.77 MiB; four-view/two-generation AO targets stay below 512 MiB and retire completely. Both GPUs pass 8,772 packing/neutral values, 30 G04 effect cases and 36 AO contribution checks. The refreshed 16-case cold/AO matrix passes correctness/resources only.

Eight CPU allocation captures (2,400 sampled frames) now attribute steady-frame object allocation separately from setup/readback/cleanup. Static and moving light-snapshot updates both allocate about 49–51 MB per 300 frames; unchanged-snapshot reuse is a concrete next optimization, not yet implemented. V8/fixture/unattributed allocations remain visible. Full root typecheck, 1,376 tests, 95 fresh example targets, shader/API checks and the real package gate pass; historical release outputs were restored after archiving the new diagnostic candidate.

G05 remains unfinished. AO memory-limited tiles use complete-light fallback with substantial observed Intel cost; no performance improvement is claimed. E/G and F full matrices and new-runtime Forward/stability qualification remain required. The previous Forward success belongs to runtime `43eaf828…`. No formal cohort or publication was started in this checkpoint. All failures remain preserved.

## Unchanged light snapshot reuse — 2026-09-28

[Implementation and validation](g05-light-cache-review.md), [eight-case before/after allocation comparison](g05-light-cache-allocation-comparison.json) and [hash-bound checkpoint](g05-light-cache-checkpoint.json) record runtime `6bb2179a…`. Unchanged validated inputs now reuse their immutable light snapshot before record/byte rebuilding. The per-World input cache is bounded at 115,584 CPU bytes; larger candidate sets use the existing path without a new admission limit.

The same native allocation harness shows static frame allocations falling about 31% on both GPUs; light-table-attributed allocation falls over 99.8%. Dynamic and four-view populations remain included (sampled-byte changes −0.48% to +1.44%), with one shared source upload per moving frame and zero static source uploads. No CPU-time or FPS improvement is inferred from these allocation estimates.

The 6,000-update differential audit preserves reference behavior, including all 194 rejections and 58 retained snapshots. Four added tests, 739 Engine / 1,380 repository tests, root typecheck and 95 fresh example build targets pass. Both native GPUs pass A/B light/culling/overflow and G04 effects/AO regressions. Budgets, versions, public API and shaders are unchanged; no publication occurred.

All processes from this checkpoint are terminal. G05 remains unfinished: high-overlap/AO-fallback GPU work, full E/G/F cohorts, current-runtime Forward qualification and the final stability audit remain required. The new source supersedes earlier runtime fingerprints for future qualification; historical evidence remains preserved.

## GPU cost and full performance attempt — 2026-09-28

The [GPU audit](g05-gpu-performance-audit.md) and [hash-bound evidence](g05-gpu-performance-audit.json) retain eight actual 300-CPU/300-GPU captures on unchanged runtime `6bb2179a…`: six host-qualified single captures, plus two Intel GTAO captures rejected for post-run CPU speed limits 75/46. They are not a complete three-cohort qualification. The initial two-capture attempt stopped for an experiment and is preserved separately; no populations were spliced.

Intel high-overlap tiled whole-GPU P95 is 62.70 ms with pre/post CPU speed/scheduler 100, against 24 ms. A rejection-only nearest-rank audit proves the current attempt cannot pass even with a theoretical zero-time completion: the pooled P95 lower bound is 62.242527 ms. Synthetic zeros were not inserted into raw evidence, and this witness cannot qualify missing cases.

The full Forward (12), F (96), and E/G (156) commands were all started serially; their first cases were rejected at host preflight (CPU speed 48, 53, 66). All three manifests, complete failure logs, raw artifacts and audit code are preserved. No complete matrix or stability audit is claimed. Three shader/binding experiments passed native pixel checks but did not establish the required Intel improvement and were reverted. No production source, ABI, quality or budget change survives this turn. The new 24-capture focus runner and failure-witness policies are covered by 185 passing performance policy tests; module/ownership/prepare/API/milestone checks pass.

All native and check processes from this attempt are terminal. G05 remains active and unqualified; complete current-runtime E/F/G/Forward populations, host-qualified AO evidence, final stability and remaining pending/package obligations are still required. No publish, version bump, commit or budget relaxation occurred.

## Cooldown timing defect repaired — 2026-09-28 11:20 UTC

After the host recovered to speed/scheduler 100, a Forward capture was rejected because timer wakeups accumulated only 119999.624 ms. This is a cooling-duration defect, not CPU throttling. The [repair review](g05-cooldown-repair.md) records monotonic deadline waiting in all four G05 capture entry points, unchanged thresholds/runtime, 190 passing policy tests, preserved failed evidence and the new complete attempt. The first instance cooldown was deliberately interrupted before sampling; no populations are spliced. Read the new live manifest for current progress; G05 remains unqualified.

## G05 evening resumption — 2026-09-28

See [resumption audit](g05-resume-audit.md) and [hash-bound evidence](g05-resume-audit.json). Four current-runtime AMD/Intel pending/AO resource captures and the real package/29-consumer qualification pass. A timer early-wakeup defect was fixed without weakening the 120-second gate; 190 policy tests pass. The fresh full Forward/F/E-G attempt subsequently failed real host preflight (86/77/88), so full timing/stability remains incomplete. All processes are terminal; G05 is not complete.

## Complete population audit — 2026-09-29

See [full performance review](g05-full-performance-2026-09-29.md) and [hash-bound final audit](g05-full-performance-2026-09-29.json). Forward 12/12, F 96/96, E/G 156/156 and high-overlap/GTAO 24/24 are terminal; all native processes have ended. Raw hashes, complete sample counts, host snapshots and unchanged runtime pass the final integrity audit. Performance qualification fails: Forward CPU regression, absolute high-overlap GPU/frameWall gaps and cross-cohort instability remain. GTAO fallback costs now have complete host-qualified three-cohort evidence, without extending the claim to all AO modes. No runtime, budget, version, baseline or publication change. G05 remains active; G06/G07 remain draft.
