# Ray tracing architecture

本目录冻结 M04 WebGPU compute ray tracing 的长期架构边界；它不表示 capability 已获准实现或已经发布。

## 阅读顺序

1. [ADR 0084](../adr/0084-webgpu-compute-ray-tracing-extension.md)：后端、包边界与准入决策。
2. [Contracts](./contracts.md)：identity、oracle、acceleration、layout、render ordering、生命周期、诊断与 evidence schema。
3. [大型能力准入](../capability-admission.md)：`hold` 到 `prototype-approved` 的机器门禁。

活动 Goal、状态和跨仓 integration order 由私有 `milestones` 仓库的
`milestones/m04-webgpu-ray-tracing/` 管理。
