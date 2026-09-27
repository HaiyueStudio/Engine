# G03 final performance acceptance

2026-09-27. **All G03 relative budgets and all 32 cohort-stability channels pass.** This is named-device G03 development acceptance, not clean-release or full product qualification. Machine data and hashes: [performance review](g03-final-performance-review.json), [evidence audit](g03-final-evidence-audit.json), [room correctness](g03-final-room-matrix.json).

## Population and integrity

The accepted population is `cohorts-2026-09-27T03-18-41.242Z`: 24 independent captures, three counterbalanced rounds, 120 warmup and 300 measured frames per capture, 900 pooled samples per algorithm/device/case and 7,200 timed frames total. All 48 before/after CPU speed/scheduler observations equal 100. Every capture declares and measures at least 120,000 ms inter-case idle, extending the original 30,000 ms minimum. Workload, resolution, quality, sample counts, percentile, relative budget and stability thresholds are unchanged. No samples are dropped or spliced.

Revision `17637dcce8855fee6ac7d0c9f944cfc27409d53b`, dirty=true; runtime `e1ace98e435a904e5c0d576e0c5e5f0a6fd30ef8fd407302f485494d021b5581`; room harness `62ed4276e9ef256db2ebd764873f0adef5fde90e4e356a82392466bef1213aac`. Raw capture hashes, build outputs and HTTP-loaded file lengths/hashes were independently verified against current files. AMD RDNA-1 and Intel Gen-9 are two native adapters on one Mac, not two physical machines or mobile qualification.

## Pooled P95 results (ms)

The comparison column measures cull+resolve for sparse256 and whole GPU span for overlap128. CPU includes prepare/record/submit; frameWall includes waiting and readback. Neither frameWall nor its reciprocal is a GPU timestamp or a sustained application FPS result.

| Adapter | Case | Reference comparison | Tiled comparison | Change | Tiled CPU | Tiled GPU span | Tiled frameWall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mac-amd-rdna1 | sparse256 | 25.992 | 1.948 | -92.50% | 3.195 | 2.664 | 10.215 |
| mac-amd-rdna1 | overlap128 | 17.582 | 14.761 | -16.05% | 2.730 | 14.761 | 34.805 |
| mac-intel-gen9 | sparse256 | 130.677 | 7.554 | -94.22% | 3.305 | 9.969 | 15.240 |
| mac-intel-gen9 | overlap128 | 69.049 | 62.894 | -8.91% | 3.670 | 62.894 | 69.315 |

Sparse256 exceeds the required 20% lighting improvement on both devices. Overlap128 remains below the allowed 10% extra whole-GPU cost on both devices. High-overlap bypass retains the complete optimized light loop and explicit reason; no light is dropped.

## Three-round stability

Each row checks CPU runtime, GPU span, lighting and frameWall separately. Limits remain relative spread ≤20% and CV ≤10%; this table shows the worst channel in each row. The original G01 sub-millisecond exceptions are not used.

| Adapter / case / path | Maximum spread | Maximum CV | Result |
| --- | ---: | ---: | --- |
| mac-amd-rdna1 / sparse256 / reference | 1.59% | 0.67% | Passed |
| mac-amd-rdna1 / sparse256 / tiled | 4.19% | 1.96% | Passed |
| mac-amd-rdna1 / overlap128 / reference | 5.72% | 2.37% | Passed |
| mac-amd-rdna1 / overlap128 / tiled | 6.10% | 2.70% | Passed |
| mac-intel-gen9 / sparse256 / reference | 2.99% | 1.40% | Passed |
| mac-intel-gen9 / sparse256 / tiled | 2.42% | 1.07% | Passed |
| mac-intel-gen9 / overlap128 / reference | 3.85% | 1.58% | Passed |
| mac-intel-gen9 / overlap128 / tiled | 2.99% | 1.29% | Passed |

The previously failing AMD overlap Tiled frameWall P95 values are now 34.730 / 34.075 / 35.190 ms: spread 3.21%, CV 1.32%. The original AMD sparse GPU-span/lighting failures also pass in this same complete population.

## Resources and complete coverage

The [eight-case matrix](g03-final-room-matrix.json) uses the exact current runtime/harness, full 720p HDR/LDR comparison and 3,600-entry heatmaps. Four extra smoke captures complete the 128-sparse / 256-overlap combinations; their timings are excluded from performance acceptance. Pixel tolerances remain max(0.002, abs(reference)×0.002) HDR and 2/255 LDR. Cleanup and GPU validation pass on both devices.

Sparse256 snapshot: 36,681 tile references versus 921,600 complete-list references, 1,900,800 B tile storage and 27,709,728 B estimated view resources. High-overlap128 bypass: 460,800 complete-list references, a legal 4 B sentinel and 25,808,932 B estimated view resources. These are allocation estimates, not measured driver residency. Heatmap arrays remain in raw captures; resource/upload breakdowns are retained in the machine report.

All measured Tiled captures create zero buffers, bind groups or render pipelines and perform zero buffer expansions/retirements. Dynamic-light scenarios upload four buffers per frame: 18,544 B at 256 lights and 9,840 B at 128 lights. Shared source uploads, camera-only reuse and pending-encoder lifetime correctness are separately covered by the current native four-view tests.

## Explicit later-owner gaps

High-overlap absolute performance is still below the G05/G07 targets:

- AMD: GPU 14.761 ms > 12 ms; frameWall 34.805 ms > 16.667 ms.
- Intel: GPU 62.894 ms > 24 ms; frameWall 69.315 ms > 33.333 ms.

The generic cohort command therefore exits 1 (`absoluteBudgetsPassed=false`) even though G03 relative budgets and stability pass. Its exit/status is retained. G03 closure follows the existing ADR/G02 handoff scope; no absolute budget is waived, widened or described as solved. G05 owns optimization/full performance matrix; G07 owns clean release and package/device qualification.

## Failed history and reproduction

The earlier complete cooled population, failed browser-flags diagnostic, thermal rejections and interrupted game-interference population remain archived. A resumed run saved 14 captures before the user confirmed and stopped a competing Chrome game; it was terminated during the next idle window. The accepted population starts fresh after that change. The observed improvement is consistent with removal of competing load, but does not prove that game caused every historical fluctuation. Browser flags were not adopted.

```sh
node scripts/webgpu-gate/run-deferred-tiled-cohorts.mjs --plan --idle-ms=120000
node scripts/webgpu-gate/run-deferred-tiled-cohorts.mjs --run --idle-ms=120000
```

Use an idle host with other continuous rendering stopped. Do not build, test or edit runtime/harness sources during capture. Preserve the whole population and verify the per-channel report rather than treating only the process exit code as G03 acceptance.
