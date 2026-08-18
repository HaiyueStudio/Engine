# Runtime convergence verification contract

## Compatibility identity

- Public surface：`review/api/release-manifest.json` 与 API surface gate。
- Shader correctness：Stage 2–14 unit/browser DAG、production cache/stale、material/deformation/postprocess/compute families。
- Renderer correctness：render pipeline/graph、object table、opaque/transparent GPU-driven batch、renderer lifecycle、render regression 与 real WebGPU product fixture。
- Asset/Worker：abort/fault/late reply/queue/dispose、gltf corpus、KTX2、Spine 与 packed worker URL consumer。
- Compute/GUI：compute family、storage→indirect ordering、GUI runtime/events/serialization/layout parity 与 lifecycle residual。
- SceneBatch：object path 是 oracle；entity id、world matrix、visible set、depth key 必须逐项相等。

## Candidate evidence

Planning baseline 只冻结 fixture identity，见 [`review/m025/g01-planning-baseline.json`](../../../review/m025/g01-planning-baseline.json)。Leaf Goal 可以生成 candidate artifacts，但不得覆盖正式 API、pixel、CPU、GPU、gzip、fidelity、screenshot 或 performance baseline。

性能报告至少包含 workload、warmup、sample、Node/browser、OS、CPU/adapter、同步/kernel/mapping/total 时间、allocation、upload、draw/pass、bundle/startup 和 correctness parity。G07 使用 ADR 0079 的预先阈值，不能在看到结果后调低。

## Validation ladder

1. focused typecheck/test/build 与 failure fixture；
2. `check:boundaries`、`modules:check`、`responsibilities:check`、`lifecycle:check`；
3. `shader-language:check`、API/packed consumer（涉及边界时）；
4. `check:fast`；
5. smoke slow 与相关真实浏览器/WebGPU case；
6. G08 才执行全量慢门禁和 M02 RC 重演。

Mock 只证明结构与状态机；renderer/shader/compute 的 GPU 行为必须有真实 WebGPU case。按 ADR 0080/0081 修订后的 M02 矩阵，0.1 正式正确性要求由 Windows 10 Chrome/Edge 与 Windows discrete 硬件边界组成；集显和 macOS 浏览器不再单列为 required 目标。
