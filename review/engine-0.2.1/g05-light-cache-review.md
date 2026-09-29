# G05 unchanged light snapshot reuse — 2026-09-28

Implementation and native diagnostics pass. G05 performance qualification remains incomplete. Runtime fingerprint: `6bb2179a2fd27d7893459dd4e52f1d9494d5f440d13ada872a327a04551d9c42`.

## Problem and implementation

The preceding [allocation checkpoint](g05-r16-checkpoint.md) found that static lights avoided GPU uploads but still recreated validation arrays, immutable records and packed source bytes every frame. `DeferredLightTable.update` only discovered equality after rebuilding them.

The table now caches the previously validated **input values** in bounded CPU storage. Identical candidate order/IDs, light values and effective shadow slots return the existing immutable source before rebuilding records or bytes. It stores values rather than references to mutable caller arrays; in-place changes remain visible. Float64 storage preserves large safe entity IDs and the original input precision. `Object.is` distinguishes signed zero and handles unchanged rejected NaN inputs.

Changed/reordered inputs use the existing validation, stable ordering, generated ABI packer and packed-byte equality path. Sub-float32 changes therefore preserve the previous generation exactly as before. Failed updates do not publish cache contents. Previously encoded snapshots remain unchanged, and shadow-slot movement cannot reuse stale light data.

The cache stores at most 1,032 candidates × 112 bytes = **115,584 CPU bytes per World**. Larger candidate sets bypass the cache and retain existing admission behavior; this is not a new scene light limit. Cached storage and source ownership remain shared across views. No GPU ABI, public export, quality, budget, version or shader changes are introduced.

## Native allocation comparison

[Complete eight-case comparison](g05-light-cache-allocation-comparison.json) pairs the same runner/harness on AMD RDNA 1 and Intel Gen 9. Each capture uses 120 warmup frames, then 300 V8 allocation-sampled frames at a 4,096-byte interval; setup, readback and cleanup are outside sampling. Raw samples, call trees, source maps, fixture/VM allocations and unattributed samples remain retained.

| GPU / case | Before KiB/frame | After KiB/frame | Sampled byte change |
| --- | ---: | ---: | ---: |
| AMD / tiled static | 629.4 | 433.0 | −31.20% |
| Intel / tiled static | 633.0 | 437.1 | −30.96% |
| AMD / tiled moving | 638.2 | 643.7 | +0.87% |
| Intel / tiled moving | 633.2 | 642.3 | +1.44% |
| AMD / reference moving | 628.3 | 625.5 | −0.45% |
| Intel / reference moving | 625.0 | 622.0 | −0.48% |
| AMD / four-view tiled moving | 1,261.3 | 1,258.8 | −0.20% |
| Intel / four-view tiled moving | 1,264.8 | 1,266.3 | +0.12% |

The static allocation attributed specifically to `DeferredLightTable.ts` drops from about 51–52 MB per 300 frames to 28,848 bytes on AMD and 61,896 bytes on Intel: over 99.8% reduction in this sampled source category. It is not exactly zero. Other frame allocations remain, explaining the smaller overall reduction.

All six moving cases remain reported, including positive changes. Their −0.48% to +1.44% differences are stochastic allocation observations, not proof of zero CPU overhead. This optimization targets unchanged inputs; it does not remove immutable snapshot creation for moving lights. These results do **not** establish CPU timing, FPS, formal stability or complete E/F/G qualification. Builds/tests ran during this explicitly diagnostic interval.

Source-upload counters are checked independently: static samples upload zero source bytes; moving samples upload exactly 300 × 8,272 bytes. Four-view samples still upload the shared source once per frame. All eight captures preserve visible output, complete light coverage, stable GPU resource creation and zero cleanup residue.

## Correctness and validation

- Four added Engine tests cover in-place component edits, normalized directions, f32-equivalent changes, signed zero, ambient/rejected diagnostics, shadow slots, query reordering, failed-update recovery, old snapshot immutability and bounded cache storage without an additional candidate limit.
- The focused source/GPU-table tests pass **23/23**; the complete Engine suite passes **739/739**.
- A deterministic **6,000-update differential audit** against the archived pre-change implementation passes: 3,875 reused snapshots, 1,931 changed snapshots, 194 matching rejections and 58 retained snapshots checked after the entire trace. The earlier rejection-heavy trace is retained separately.
- Both GPUs pass the original A/B native oracles: **7 complete-light reference cases and 32 tiled cases per GPU**, including boundary/overflow, light mutation, stable IDs, multiview and capacity recovery checks.
- Both GPUs also pass **30 effect/path cases and 36 AO contribution checks**, preserving direct/emissive/transmitted lighting and existing shadow/environment behavior.
- Module, responsibility, synchronous-prepare and API checks pass. The unchanged performance gate policies pass **176 tests**.

Root typecheck, **1,380 repository tests** and the complete build have now passed; examples report **95 fresh targets**. All owned build/native processes are terminal. The [hash-bound checkpoint](g05-light-cache-checkpoint.json) retains the raw evidence, archived source, differential scripts and check logs. No package/export or shader source changed in this optimization; the previous package check remains historical rather than a new-runtime release qualification.

## Remaining work

The high-overlap and AO full-list-fallback GPU costs are unchanged by this CPU optimization. Their profiling/optimization, the full E/G and F cohorts, new-runtime Forward qualification and final stability audit remain required. Prior runtime qualifications remain historical; no G05 completion, G06/G07 activation, publish, tag or push is claimed.
