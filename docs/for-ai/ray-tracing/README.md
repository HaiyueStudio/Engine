# Ray tracing architecture

本目录冻结 M04 WebGPU compute ray tracing 的长期架构边界。当前已有 experimental
`@haiyue/extensions/ray-tracing`、Engine example、Scene Editor lazy 插件和 Games 产品候选；G10 正式验收仍
未完成，因此这些内容不表示 stable API 或已经发布。

## 阅读顺序

1. [ADR 0084](../adr/0084-webgpu-compute-ray-tracing-extension.md)：后端、包边界与准入决策。
2. [Contracts](./contracts.md)：identity、oracle、acceleration、layout、render ordering、生命周期、诊断与 evidence schema。
3. [大型能力准入](../capability-admission.md)：`hold` 到 `prototype-approved` 的机器门禁。

活动 Goal、状态和跨仓 integration order 由私有 `milestones` 仓库的
`milestones/m04-webgpu-ray-tracing/` 管理。

## Candidate entrypoints

- `npm run build:target -- example:ray-tracing`：构建 small analytic 与 medium PBR progressive example。
- `node scripts/webgpu-gate/verify-ray-tracing-example.mjs`：Chrome/Edge 原生 WebGPU、path hit、非退化像素、memory 与诊断门禁。
- `node scripts/benchmark/verify-ray-product-candidates.mjs`：同时验证 example 与 Games/Gravity Maze 大场景，以及默认 bundle 不携带 RT runtime。
- `npm run ray-tracing:g10:review`：向 ignored `artifacts/ray-tracing-g10-review/` 生成 raw、denoised、variance、history-age、feature 与产品场景 PNG；它不晋升 baseline。

当前 G10 候选/no-go 记录见 [G10 candidate status](./g10-candidate-status.md)。
