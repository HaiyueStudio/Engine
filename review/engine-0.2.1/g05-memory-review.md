# G05 resource attribution checkpoint — 2026-09-28

Status: structural checks pass; **native memory qualification remains incomplete**. This checkpoint does not complete G05 or claim driver-resident memory measurements.

## Measurement coverage

Room capture now retains every live tracked buffer/texture record at the warm, CPU and GPU boundaries. Records include unique ID, owner, label, creation frame and estimated bytes. The evaluator independently recomputes category/view sums and checks them against the shared tracker's totals; missing, duplicated, unclassified Deferred or inconsistent records fail validation.

Categories distinguish G-buffer, tile index buffers, shared light sources, view records, parameters, AO and ordinary resources. View keys retain their entire identity, including embedded colons. All shared Deferred storage is conservatively charged to each view for the per-view ceiling, while the actual aggregate is reported separately. These E/G scenes have no active AO pass; the neutral AO binding is included.

The unchanged limits are 67,108,864 bytes per view/generation and 536,870,912 total Deferred target bytes. Stable E/G captures must have one four-texture G-buffer generation per view, no extra tile generations and no Deferred allocation growth after warmup. This single-generation gate does not establish the pending-generation lifecycle requirement by itself.

## Actual-renderer structural check

`node scripts/webgpu-gate/check-deferred-g05-memory-structure.mjs` uses the current hash-verified private runtime and the shared versioned audit GPU device. It runs the renderer's real allocation/ownership code with 128 point lights. No native shaders execute and no timing or pixel result is inferred.

| Resolution / views | Reference Deferred bytes | Tiled Deferred bytes |
| --- | ---: | ---: |
| 1280×720 / 1 | 26,088,968 | 27,990,792 |
| 1280×720 / 4 | 103,503,368 | 111,107,592 |
| 1920×1080 / 1 | 58,344,968 | 62,654,472 |
| 1920×1080 / 4 | 232,527,368 | 249,762,312 |

All eight cases pass the conservative per-view and total ceilings, stable phase allocation checks and zero owner/live-resource cleanup. Values are descriptor-based allocations for the exercised workload; they exclude ordinary resources from the Deferred subtotal but retain those ordinary resources in the raw record inventory. They are not measured driver residency or bandwidth.

Artifact: `artifacts/engine-0.2.1/g05/memory-structure-2026-09-28T01-08-56.463Z.json`. Its hash is recorded in `artifacts/engine-0.2.1/g05/checks/memory-2026-09-28/evidence.json`.

## Pending generations and capacity

A separate structural check uses the current private target-pool/tile-resource source with the same shared audit device. Four views retain both 1904×1072 and 1920×1080 generations on an unsubmitted encoder: 32 G-buffer textures and eight tile buffers, totaling **494,917,952 bytes**. Each generation's planned view cost is below the frozen 64 MiB ceiling, and the combined target cost is below 512 MiB.

- A third G-buffer generation fails with `live-target-generations`.
- A third growing tile-buffer generation fails with `tile-live-generations`.
- A fifth view fails with `view-count` / `tile-view-count`.
- Rejected requests create no buffer or texture.
- Destroying the owners before submission retains every referenced resource. After submission/completion callbacks, the resource inventory is empty.

This proves the exercised G-buffer/tile owners' structural capacity and lifetime behavior. It does not establish physical low-limit GPU behavior, native pending-submission safety, AO resource cost, or the in-flight high-water mark of all other renderer owners. Existing G04 native lifecycle evidence remains separate, and G05 still requires current native attribution.

## Validation and remaining work

Ten focused memory/cohort/stability tests and all **165 performance policy tests** pass. New script syntax, the unchanged 156-job E/G plan and whitespace checks pass. Logs also retain initial harness failures: missing explicit simulated-device limits, setup upload counters before reset, and a previously unclassified tile parameter label. Those harness issues were corrected before the passing structural capture; no Engine runtime change was needed.

Next: after the active instance cohort run, validate the updated room fixture on both GPUs, run the full E/G captures and independently audit timing, stability and resource budgets. Complete native low-limit/capacity, AO/cold-pipeline attribution and default Forward regression. Keep the G01 budgets and accepted G04 AO semantics unchanged.

## Native steady-state follow-up

The subsequent [native checkpoint](g05-native-resource-checkpoint.md) completes short steady-state attribution on both GPUs for all 52 E/G workload/path combinations. Their recorded resources match the shared tracker totals and pass the unchanged per-view/total ceilings with no measured-frame GPU allocations or cleanup residue. Timing qualification, native pending-generation high water and AO/cold cost remain incomplete.
