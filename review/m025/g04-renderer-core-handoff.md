# M2.5 G04 renderer core handoff

- Goal / source revision / candidate revision: `g04-parameterized-renderer-core-correctness`; source `9355da5`; candidate is the clean commit containing this handoff.
- Changed owners:
  - Object-table, stable/batch slot, upload phase, material identity, pipeline-key and renderer abort lifecycle: per-renderer copies -> composed `ParameterizedRendererCore`.
  - Shared geometry acquisition/release: per-renderer maps and loops -> `SharedGeometryRendererOwner`; Mesh and Volume keep renderer-specific geometry update policy behind `RendererCacheGeometryOwner`.
  - Depth-key policy: independent CPU/GPU-driven constants -> `DepthSortPolicy` with one scale, clamp and reverse-key definition.
  - Per-view material scratch: mutable `Render3DSystem` fields -> `Render3DMaterialContextScratch`, reset after every record attempt.
  - View extraction: duplicated plan/record postprocess, jitter and camera-frame work -> one immutable planned-view entry consumed by `_recordView()`.
- Deleted duplicate state machines/files/branches:
  - Removed direct `RendererObjectTable` construction and duplicate slot-cache lifecycle from Mesh, PBR, BlinnPhong, Toon, Depth, Normal, Volume and Instanced renderers.
  - Removed the empty `Render3DTransparentOrchestrator.destroy()` owner and its call site.
  - Removed test-only facade seams and updated benchmarks to consume the real frame/view owners.
  - Replaced renderer-local depth quantization literals with the shared typed policy.
- Public API / format / package diff: none. No stable export, Scene/HYA/Voxel format, generated shader, pixel baseline or performance baseline changed.

## Shared owner graph

```text
Render3DSystem
  -> planned view snapshot (postprocess + jitter + camera frame + scene)
  -> Render3DMaterialContextScratch (reset in finally; nested record rejected)
  -> renderer facade
       -> ParameterizedRendererCore
            -> RendererObjectTable / RendererObjectSlotCache
            -> SharedGeometryRendererOwner or RendererCacheGeometryOwner
            -> upload phase + material identity + pipeline key
            -> AbortController (destroy aborts; late result releases)
```

## Renderer migration and parity

| Renderer | Geometry policy | Shared state consumed | Parity evidence |
| --- | --- | --- | --- |
| Mesh | renderer cache/update | stable+batch tables, slots, upload, material/pipeline, abort | resource lifecycle batches/textures; Stage 9 and planar reflection |
| PBR | shared geometry | tables, slots, upload, material/pipeline, abort | resource lifecycle batches; PBR pixels; Stage 9 |
| BlinnPhong | shared geometry | tables, slots, upload, material/pipeline | resource lifecycle batches; Stage 9 |
| Toon | shared geometry | tables, slots, upload, material/pipeline, abort | Stage 9 and shader verification |
| Depth | shared geometry | tables, slots, upload, material/pipeline | deformation batch fixture; shadow/depth WebGPU paths |
| Normal | shared geometry | tables, slots, upload, material/pipeline | sparse upload, clipping reuse and instancing fixtures |
| Volume | renderer cache/update | tables, slots, upload, material/pipeline | focused volume lifecycle fixture; real renderer suite |
| Instanced | shared geometry | geometry lifecycle and pipeline key | Stage 9 instanced family and real renderer suite |

The convergence contract test rejects a target renderer that recreates its own object table. Existing object-slot, geometry reuse, upload and pipeline behavior remains covered by the renderer lifecycle and real-renderer suites.

## Fault injection and lifecycle result

| Injection | Expected result | Result |
| --- | --- | --- |
| Mesh texture resolves after renderer destroy | late-result write `0`; loaded GPU handle released once | passed focused lifecycle test |
| Texture source replaced while previous request is pending | stale source cannot write the material slot | retained identity guard plus owner signal |
| Object table grows during a frame | replaced buffer survives until `afterSubmit` | passed focused lifecycle test |
| Last geometry owner leaves | shared buffers release exactly once; earlier owner release leaves them live | passed focused lifecycle test |
| Device recovery | view-local GPU owners are recreated without stale frame references | passed architecture-owner fixture and real WebGPU validation |
| Nested `record()` | structured invalid-state error before shared scratch mutation | passed focused architecture test |
| Repeated/multi-view depth input | identical CPU/GPU key and stable tie-break, including near-coplanar, negative and huge depth | passed transparent-key property fixture |

GPU owner residual is zero for the exercised destroy/recovery fixtures. GPU-driven cull readback remains explicitly telemetry-only; this Goal does not claim an occlusion feedback loop.

## Validation

- `npm run typecheck -w ./engine`; `npm test -w ./engine` (521 passed); `npm run build -w ./engine`: passed.
- Focused renderer integration: 71 passed. Benchmark lifecycle/source contracts: 14 passed.
- `npm run modules:check`; `npm run responsibilities:check`; `npm run lifecycle:check`; `npm run renderer-prepare:check`; `npm run api:check`; `npm run check:boundaries`: passed.
- `npm run verify:shader-language-stage9`: passed the recursive real-WebGPU shader/render DAG, including 3 Stage 9 families and 15 passes, with GPU validation error 0.
- `npm run verify:pbr-pixels`: exact pixel baseline passed (`a2ae2374`).
- `npm run verify:planar-reflection`: 4 real-WebGPU cases and 4 pixel gates passed.
- Real-renderer benchmark: all 8 scenarios passed. Three Windows discrete-GPU P95 samples exceeded existing diagnostic references; planar reflection recorded two diagnostic P95 exceedances. These are not correctness failures, no performance claim is made, and no budget or baseline was promoted.

## G07 extraction seam / JS oracle

- Batch input seam: immutable frame items produced by `Render3DViewPreparation` and consumed by renderer batch preparation.
- Renderer lifecycle seam: `ParameterizedRendererCore` exposes composed object/geometry ownership without importing renderer facades.
- Sort oracle: `DepthSortPolicy` plus the transparent cross-path fixture is the JS reference for any optional numeric backend.
- Benchmark seam: `scripts/benchmark/real-renderer-scenario.mjs` and `suite.mjs` access the real view-preparation/frame-coordinator owners.
- A G07 backend must remain optional, reproduce these JS results, preserve fallback/device recovery and may not reintroduce renderer-owned scheduling or submission state.

- Deferred or blocked items: transparent motion vectors/transparent instancing/multilayer transmission remain held capabilities. Renderer threads remain outside M2.5 unless separate admission evidence exists.
- Follow-up required from G08: replay renderer, pixel, real-WebGPU, lifecycle and architecture gates from a clean integrated revision; treat diagnostic performance samples as observations, not formal evidence.
