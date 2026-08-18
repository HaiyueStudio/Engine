# M2.5 G08 final owner and deletion matrix

| Area | Final owner | Removed duplicate/temporary path | Retained boundary |
| --- | --- | --- | --- |
| Production shader source/reflection | shader-language family source + generator validator | production V1 writer/reader, independent engine V2 declarations, WGSL binding rewrite | raw CustomPass/ComputeKernel/Composer escape hatches remain explicit |
| Shader runtime artifact | generated private engine declaration + `PrecompiledShaderRuntime` | runtime compiler/Graph parsing and dual schema branches | Artifact V2 only |
| Frame order | `RenderFramePlanCompiler` | mutable Pipeline entry sorting | RenderGraph owns logical dependencies; Pipeline owns actual pass compatibility/submission |
| Renderer object/geometry/upload | `ParameterizedRendererCore` plus injected geometry policy | eight renderer-local object table/slot/upload owners | shader/material/pass policy stays renderer-specific |
| Depth sort | `DepthSortPolicy` | independent CPU/GPU quantization constants | stable entity/material tie-break remains unchanged |
| Renderer scratch/late async | call-scoped scratch + renderer abort owner | cross-view mutable scratch and late texture write-back | nested record is a structured error |
| Worker transport | `WorkerChannel` | per-client pending/request/fault/dispose state machines | KTX2 pool keeps capability-level bounded scheduling |
| Abort/priority/clock | `AsyncPrimitives` | glTF/Spine/KTX2 local helper copies | diagnostics retain consumer domain/path |
| Asset phase | `AssetJob` transition table | `AssetManager` writable phase mirror | job state in error context is diagnostic only |
| Compute order | `ComputeResourceAccess` | implicit storage-write/indirect call-order assumption | explicit token validator; WebGPU performs synchronization |
| GUI vertex ABI | private `GuiVertexLayout` descriptors | independent stride/offset declarations | public float-count aliases derive from the descriptor |
| GUI GPU lifetime | renderer/device sampler and resource owners | per-entry sampler creation and partial-init residue | non-destroyable GPU objects release references |
| GUI persistence | `haiyue.gui@1` validator/serializer | trusted typed input and unversioned payload | exact `$` paths and serialization-domain errors |
| Scene numeric batch | benchmark-only `SceneBatchCandidate` | production `Render3DSceneBatch` and controller | object ECS/runtime path remains authoritative; raw parity workload stays reproducible |
| WASM backend | none (ADR 0079 no-go) | candidate runtime was not admitted | benchmark evidence retained; public call count/gzip delta zero |

Audit searches found two names that are intentionally not duplicates:

- `MaterialGraphDeploymentArtifactV1` is the separately versioned authoring/deployment facade, not a production renderer shader artifact.
- `engine/src/shader/PrecompiledShaderArtifact.generated.ts` repeats the canonical shape only as generated output; its freshness test rejects independent edits.

No permanent compatibility writer, second renderer owner, old Worker transport, or production WASM runtime remains.
