# G05 native lifecycle and cold/AO cost checkpoint

Status: **partial diagnostic evidence; G05 remains active**. Runtime fingerprint remains `43eaf828b7dc68a3f6e7bdd1e591bf71d07d6ad4f47b777ec54a9ae5fe5c5baf`. No runtime, public API, budget, version or release baseline changes in this checkpoint. The [hash-bound index](g05-lifecycle-cost-checkpoint.json) links all raw evidence.

## Pending resource generations: both native GPUs pass

AMD RDNA 1 and Intel Gen 9 each execute actual render clears, compute writes and readback after resource-owner destruction but before submission. Four views retain 1904×1072 and 1920×1080 generations: 32 G-buffer textures plus eight tile buffers, **494,917,952 estimated bytes** (472.0 MiB), below 512 MiB. Diagnostic readback storage is separately attributed.

All eight generation/view pairs return the expected RGBA16F clear and tile sentinel. All referenced records survive owner destruction until submission; completion releases every buffer/texture. Third-generation and fifth-view requests reject before allocation. Native validation errors are zero. This establishes descriptor allocation/lifecycle behavior, not driver-resident memory or performance. The focused private bundle uses the unchanged Engine source and does not add public exports or replace the main G05 fixture.

## Low limits: record actual capability, never simulated hardware

Each native GPU received seven below-requirement requests. Actual limits remained: storage buffers/stage 8, color attachments 8, storage binding 134,217,728 bytes, workgroup X 256. They cannot exercise the intended rejection thresholds (5, 3, 66,064, 64 respectively).

This follows WebGPU's default-limit floor: a device starts with default limits and requested capabilities can improve them. See the [WebGPU capability and device creation specification](https://www.w3.org/TR/webgpu/#dom-gpuadapter-requestdevice). All 14 rows explicitly report **unavailable**, with `physicalLowLimitQualified: false`. Existing injected rejection/capacity tests and default-limit native rendering remain separate evidence. Do not claim a physical device below core WebGPU defaults or broaden support to compatibility-mode/mobile devices. The initial failed assumption and consumed-adapter retry are preserved.

## Cold creation and AO attribution: 16/16 diagnostic captures pass

Frozen moving small-8 room, 720p, reference/tiled, AO off/GTAO/SAO/SSAO, AMD/Intel. AO settings are radius 2, intensity 3, full resolution, high quality. Each fresh browser/device retains scenario/profile creation calls, first-frame timing, module SHA-256/UTF-8 bytes, pipeline-to-module references, CPU/API call time and async completion time. Browser/driver caches are **not forcibly cleared**; these timings are not isolated driver compiler time.

| Path / AO | Unique shader bytes | Shader variants | Pipeline creation calls | Deferred allocation bytes |
| --- | ---: | ---: | ---: | ---: |
| Reference / off | 337,738 | 17 | 6 | 26,088,968 |
| Reference / GTAO | 363,590 | 21 | 10 | 40,834,824 |
| Reference / SAO | 360,934 | 21 | 10 | 40,834,824 |
| Reference / SSAO | 361,336 | 21 | 10 | 40,834,824 |
| Tiled / off | 346,415 | 18 | 7 | 27,990,792 |
| Tiled / GTAO | 372,267 | 22 | 11 | 42,736,648 |
| Tiled / SAO | 369,611 | 22 | 11 | 42,736,648 |
| Tiled / SSAO | 370,013 | 22 | 11 | 42,736,648 |

Both devices have identical creation counts/bytes. AO adds 14,745,856 bytes of visibility storage (14.06 MiB), while **total tracked allocations** increase by 31,491,860 bytes because auxiliary depth/normal/pass resources also count. This avoids presenting visibility storage alone as total AO cost. Both existing AO owners' 260-byte neutral buffers are included. Full allocation inventories and per-pass timestamps remain in raw artifacts.

All HDR/LDR parity checks pass, resources remain stable, steady samples create no shader/pipeline, cleanup is zero. Each capture has two warmup and three CPU/three GPU samples, so **no FPS or performance qualification follows**. Host snapshots were 100, but local policy checks overlapped this explicitly diagnostic matrix. Formal cohorts must run alone after cooling. Frozen G04 direct/emissive/IBL AO semantics remain accepted and unchanged.

## Validation and remaining work

- All **173** performance policy tests pass, including unavailable-versus-passed classification, genuine GPU output, premature retirement, shader attribution, AO storage and stable creation checks.
- `git diff --check` passes. Original main runtime and package artifacts remain unchanged.
- All failed runs and final logs are retained under `artifacts/engine-0.2.1/g05/checks/lifecycle-cost-2026-09-28/`.
- Full Forward 12 captures, E/G 156 captures, F 96 captures, stability/final audits, CPU-object allocation attribution and qualified AO timing remain outstanding. Historical high-overlap GPU and instance frame-wall concerns remain open; no budgets or populations were relaxed.

### Follow-up scope correction

The later [1080p AO review](g05-ao-memory-budget-review.md) confirms a per-view allocation failure on both GPUs. The passing 720p matrix and pending G-buffer/tile test above must not be read as universal AO memory qualification. The full default Forward run subsequently [passed all 12 captures](g05-forward-qualification.md); the latest performance-policy count is 174.
