# 0003：公共 API 稳定性分层

- 状态：Accepted
- 日期：2026-07-10

## 背景

当前 engine 默认入口同时导出高层场景 API、ECS、材质与几何，以及 RenderCommandContext、GPU-driven buffer、compute pass、缓存和 worker source builder。所有内容都从默认入口可见，会让内部实现快速变成事实公共 API。

## 决策

公共表面分为三层：

1. **stable**：默认入口及明确的稳定领域入口。只包含普通游戏和编辑器集成长期需要的高层能力。
2. **experimental**：统一从 `@haiyue/engine/experimental` 暴露。允许破坏式调整；editor core 不能直接依赖，必须由 engine-adapter 封装。包作用域由 [ADR 0007](./0007-haiyue-brand-and-package-scope.md) 确定。
3. **internal**：不出现在 `package.json#exports`。包外代码和其他 workspace 无法导入；测试使用包内测试或专用 testing entry。

补充规则：

- 新增 stable export 必须更新 API baseline、文档和对应 ADR/设计说明。
- 本项目当前没有历史兼容要求。API 调整在同一阶段全仓替换，不使用 deprecated alias、旧入口 re-export 或双字段读取。
- 阶段一只冻结当前表面作为基线；具体收敛在阶段二一次完成，不能在阶段一零散迁移。
- `components` 的 glTF、Spine、tilemap 等大型可选能力继续使用可 tree-shake 的 subpath，根入口不得无条件引入重型实现。
- 自定义材质所需的 `MaterialRendererRegistration`、`MaterialRenderContext` 等能力协议属于 stable；协议不得引用具体 GPU-driven buffer、readback、table 或 cache 实现。
- `api-surface` 在 baseline 比较前执行稳定性语义检查。GPU-driven buffer/table/readback、command buffer、renderer cache 与底层 compute pass 即使经过人工执行 `api:update`，也不能进入 stable entrypoint。

## 后果

- 默认入口更容易学习，内部渲染和缓存实现可持续重构。
- experimental 使用方必须接受同仓破坏式迁移。
- API baseline 变化会让 CI 失败，防止无意扩大公共表面。
