# Runtime convergence contract

本目录是 M2.5 的冻结架构输入。执行顺序由 [ADR 0074](../adr/0074-pre-release-runtime-convergence-sequencing.md) 决定，完整 owner 与重复状态机见 [owner-matrix.md](./owner-matrix.md)，兼容和证据口径见 [verification-contract.md](./verification-contract.md)，未准入能力见 [deferred-capabilities.md](./deferred-capabilities.md)。

## 固定边界

- 0.1 stable API、错误 code、Scene/HYA/Voxel/GUI 外部格式、浏览器支持和正式 baseline 是只读输入。
- `shader-language` 拥有生产 shader 生成 schema；engine 只消费 private generated contract。
- RenderGraph 编译逻辑计划，RenderPipeline 解析真实 target 并执行/submission。
- engine private async substrate 拥有通用 Worker/abort/priority/clock；具体 worker source 留在 capability owner。
- JS ECS 是权威状态；SceneBatch/WASM 只允许作为可移除的派生批量后端。
- G02–G07 不更新 root manifest、公开 API baseline、正式像素/性能 baseline 或 milestone 完成状态。

## Goal 输入

| Goal | 冻结输入 | 必须删除的重复 owner |
| --- | --- | --- |
| G02 | ADR 0075、shader family/source matrix | binding replace、V1 writer、engine 独立 V2 schema、手工 cost 记账 |
| G03 | ADR 0076、frame/plan/submit seam | target 恒等占位、重复 pass compatibility 决策 |
| G04 | G03 typed plan、renderer parity fixtures | 重复 object/geometry/upload owner、跨 view scratch、迟到 async writeback |
| G05 | ADR 0077、failure matrix | consumer 自建 channel/abort/priority/clock、直接 job phase 写入 |
| G06 | ADR 0078、layout/serialization fixtures | magic stage/layout、GUI 双份 vertex layout、无版本 payload |
| G07 | ADR 0079、current object path oracle | 无收益 WASM、第二套 ECS 权威状态、逐实体跨边界调用 |

Leaf Goal 完成时使用 [`review/m025/handoff-template.md`](../../../review/m025/handoff-template.md)，报告 owner 变化、删除清单、验证、candidate evidence 与 deferred 项。
