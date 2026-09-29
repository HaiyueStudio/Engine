# G05 AO memory repair and CPU allocation checkpoint — 2026-09-28

**Diagnostic verification passed; G05 is not complete.** Current runtime is `ce94c5127913b6cd9339d48b06bf49465a2893861c3f91b70f412177d34aa32c`. The [hash-bound index](g05-r16-checkpoint.json) records 34 artifacts, check logs and the relocated package candidate. The earlier [AO budget failure](g05-ao-memory-budget-review.md) remains preserved as history.

## Runtime change and memory result

AO visibility now uses R16F targets and padded half-float storage words. CPU header/copy layout and all generated lighting consumers changed together; no sampled-texture binding, quality option, G-buffer/light ABI or public export changed. Private AO layout is version 2. Joint AO/tile planning retains the frozen 128-index tile record and uses the existing complete-light fallback for tiles that cannot be stored.

A shared per-device ledger reserves live and pending Deferred target bytes before allocation. Pool, tile and AO owners release reservations after submitted work completes; preparation/allocation failures return their reservations. Four-view/two-generation limits remain explicit. Shared source/view/parameter storage receives a conservative reservation; AO auxiliary scratch is still separately visible in the full resource inventory. These are descriptor estimates, not physical driver-resident memory.

| Native workload (both AMD and Intel) | Estimated Deferred bytes | Unchanged ceiling |
| --- | ---: | ---: |
| 1080p / 128 moving lights / full-resolution high GTAO | 66,869,272 (63.77 MiB) | 67,108,864 |
| Four views / two pending generations / AO off | 494,917,952 | 536,870,912 |
| Four views / two pending generations / AO on | 532,674,052 | 536,870,912 |

The 1080p workload previously allocated 95,832,328 bytes (91.39 MiB). Its current whole tracked allocation is 142,606,068 bytes, including other renderer/AO resources; the per-view Deferred figure must not be presented as total GPU memory. Both captures preserve HDR/LDR parity and zero cleanup residue.

### Cost and support boundary

At 1080p with one AO pass, only **433 of 8,160 tiles** fit; **7,727 tiles** use the full light list. Every light remains represented. The short diagnostic GPU spans were about 27.85 ms on AMD and 184.59 ms on Intel. These are three-sample observations, not qualified P95/FPS results or a speedup claim. The fallback cost remains a performance issue.

Two chained full-resolution AO passes at 1080p exceed the fixed per-view limit even before useful tile storage. The planner returns an explicit `view-deferred-bytes` capability failure; it does not lower AO resolution/quality. The profile's existing strict/Forward failure policy applies. Smaller valid workloads retain their original AO semantics.

## Native lifetime and pixel coverage

- Both native GPUs retain all eight view/generation pairs after owner destruction and before submission, execute actual render/compute work, then read the expected G-buffer, tile and AO values. Referenced resources survive until completion; every owner and budget reservation is subsequently empty.
- Third-generation, fifth-view and competing-profile capacity requests fail before creating GPU resources.
- R16F packing probes use the production AO owner, texture-to-buffer copy and WGSL reader at 17×9, 129×3 and 1920×2. Each GPU checks **8,772 values**, including odd/even pixels, row padding, last pixels, coordinate clamping and neutral visibility. Diagnostic patterns are not substitutes for AO algorithm coverage.
- The current-runtime G04 effect suite passes **30 effect/path cases and 36 AO contribution checks per GPU**. GTAO/SAO/SSAO preserve direct, emissive and transmitted light, while occluding ambient/IBL. Maximum ordinary effect parity delta is 1/255.
- The complete **16-capture** 720p cold/AO matrix passes resource, pixel and cleanup checks. R16F visibility adds 3,686,656 bytes at 720p; full AO resource growth remains separately reported. Shader/pipeline creation is absent from steady samples. Build/check activity overlapped this diagnostic matrix and host CPU limits were reduced, so its timings are not promoted.

## CPU object allocation attribution

Eight captures cover both GPUs: moving/static sparse-128 tiled, moving sparse-128 full reference, and moving 128-light four-view tiled. Each warms 120 frames and samples 300 frames. An explicit DevTools/fixture handshake starts after warmup and stops before readback/cleanup. The shared Chrome runner's original whole-page sampling behavior remains available for existing callers.

All **2,400 sampled frames** retain raw V8 allocation samples and call trees, including objects later collected by minor/major GC. The [allocation audit](../../artifacts/engine-0.2.1/g05/cpu-allocation-audit-2026-09-28T03-41-36.266Z.json) verifies the complete matrix, hashes, source maps, sample totals, native output and cleanup. These stochastic weighted byte estimates include benchmark/VM allocations and cannot be called exact object counts or CPU time.

| Capture | AMD sampled KiB/frame | Intel sampled KiB/frame |
| --- | ---: | ---: |
| Tiled / moving / one view | 638.2 | 633.2 |
| Tiled / static / one view | 629.4 | 633.0 |
| Reference / moving / one view | 628.3 | 625.0 |
| Tiled / moving / four views | 1,261.4 | 1,264.8 |

`DeferredLightTable.update` accounts for about 49–51 MB across 300 frames in all eight captures, including static lights. Source inspection confirms validation arrays, frozen record tuples and packed snapshot bytes are reconstructed before equality returns the previous static snapshot. Static GPU upload suppression therefore does not eliminate CPU allocation. The approximately constant light-table contribution across one/four views also supports its shared ownership.

`DeferredReferenceBackend.record`, frustum checks, iterator `next` and benchmark scene construction of update inputs are additional sources; the report keeps them separate. Some V8 samples have no matching returned call-tree node (about 0.33 MB per capture). Their bytes stay in totals and are explicitly unattributed; no samples were discarded. Initial fixture module-identity and overly strict missing-node validation failures remain saved.

The next bounded runtime optimization is avoiding unchanged light-snapshot reconstruction while preserving immutable older snapshots, stable IDs, diagnostics, ordering and shadow-slot semantics. This checkpoint measures that opportunity; it does not claim the optimization is implemented.

## Repository and package checks

- Root typecheck, **1,376 tests** (including 735 Engine tests) and root build pass. The example build reports **95 fresh targets**.
- Module/responsibility/prepare/API checks pass. Shader generation/cache verification passes: **561,776 bytes, 75 WGSL files, 67 variants/pipelines**, within the approved 570,000-byte budget.
- **176 performance policy tests**, five new allocation phase/policy tests, three strengthened pending-resource policy tests and shared Chrome server/cleanup tests pass. Milestone validation and `git diff --check` pass.
- Real package installation, deterministic repacking, all **37 Engine type entrypoints** and existing consumer budgets pass. Engine has **498 files**, 1,831,465 packed bytes and 7,598,647 unpacked bytes.
- Package output is archived under `g05/package-r16-2026-09-28T03-43/candidate/`. Original canonical release reports/tarballs were restored; the candidate report's original `artifacts/release/npm` references resolve through that archive's `candidate/npm` directory. No publish, tag, push, version/budget change or release promotion occurred.

## Remaining G05 acceptance

Complete E/G 156-capture and F 96-capture cohorts, current-runtime Forward 12-capture qualification, high-overlap/instance-wall performance issues and the final stability/source audit remain open. The successful Forward run on runtime `43eaf828…` is historical and cannot qualify this new runtime. Physical below-core-limit coverage remains unavailable on these adapters and is not represented as passed hardware support. Full performance collection must run alone after host qualification; none was started during the diagnostic/build interval above.

### Follow-up — unchanged snapshots now reuse CPU input validation

The [next checkpoint](g05-light-cache-review.md) implements the static light-snapshot opportunity identified above at runtime `6bb2179a…`. Its paired eight-case allocation evidence and complete correctness/build checks are separate from this historical R16F checkpoint. Full performance qualification remains open.
