# ADR 0061: Focused experimental entrypoints

## Context

`@haiyue/engine/experimental` 已聚合 784 个 value/type 符号。它仍是明确的非稳定入口，但单一大入口无法表达责任归属，也会让高级 consumer 无意间依赖资产、诊断、renderer 与 GPU-driven 的全部实现面。

同时，Shader Language 已成为根 npm workspace，但 API workspace graph 尚未登记它，依赖方向变化无法进入 API diff。

## Decision

1. 保留 `/experimental` 作为同仓兼容聚合，本轮不制造 breaking change；API gate 将其预算冻结在当前 784 个符号。
2. 新增四个有独立预算的实验性入口：`/experimental/assets`、`/experimental/diagnostics`、`/experimental/gpu-driven`、`/experimental/renderer`。
3. focused subpath 只能导出兼容聚合中已有的符号；新增或移动符号必须同时通过 API diff 和预算检查。
4. stable 入口检查排除所有 `/experimental/*`，但不会因此把它们视为 stable。
5. `shader-language` 加入 API workspace graph，但 compiler package 仍为 private，不纳入 SDK public package surface，也不成为 engine runtime dependency。
6. 插件文档必须以真实 `PluginRollbackScope` API 为准，外部副作用使用 `context.rollback.track()`。

## Consequences

- 旧 import 保持可用；新工具和诊断代码可以表达最小低层依赖。
- aggregate 不再无上限增长，focused entrypoint 也不能成为新的垃圾抽屉。
- Shader compiler 的 workspace 名称、private 状态和 workspace dependency 会进入 API baseline。
