# For AI & Maintainers

本目录面向 AI agent、引擎维护者和需要修改内部实现的贡献者。内容强调模块边界、核心不变量、资源所有权、研发状态和验证门禁，不作为普通用户的入门教程。

## 阅读顺序

1. [Repository map](./repository-map.md)：确认代码和文档的所有权边界。
2. [API stability](./api-stability.md)：确认 stable、experimental 和 private 的区别。
3. [ADR index](./adr/README.md)：查找影响当前修改的架构决策。
4. 按任务读取性能、能力覆盖和发布文档，不要默认加载全部 ADR。
5. [从源码运行、贡献与验证](./contributing.md)：安装、目标构建、端口、门禁和 baseline 边界。

## 架构与研发资料

- [Architecture Decision Records](./adr/README.md)
- [Stable API 边界](./api-stability.md)
- [Stable capability coverage](./capability-coverage.md)
- [Performance workflow](./performance.md)
- [灯光与阴影规模化基准协议](./lighting-shadow-scaling.md)
- [大型能力准入](./capability-admission.md)
- [Ray tracing contracts](./ray-tracing/README.md)
- [Source-neutral deformable animation contracts](./deformable-animation/README.md)
- [Shader Language / Typed IR 阶段 13 实现与契约](../../shader-language/README.md)
- [Release process](./release-process.md)
- [从源码运行、贡献与验证](./contributing.md)
- [文档维护约定](./documentation-conventions.md)
- [Milestones 与 Goals](../../../milestones/README.md)

## 当前研发状态

结构化阶段目标、依赖和执行顺序以 [`milestones/`](../../../milestones/README.md) 为准；尚未进入里程碑的候选事项保留在 [`todos/`](../../../milestones/todos/)，评审结论、阶段基线和数值证据保留在 [`review/`](../../review/)。本目录只维护稳定的架构索引和约束，不复制会快速过期的 Goal 状态。

开始修改前应同时检查：

- 目标目录是否存在 `AGENTS.md` 或其他局部约束；
- 对应 ADR 是否已经规定 API、生命周期或包边界；
- `milestones/` 是否存在当前任务对应的 Goal、共享 contract 和 integration 顺序；
- `review/` 是否已有评审结论或数值基线；
- `todos/` 是否还有尚未纳入里程碑的相关候选事项；
- 修改完成后应运行哪些结构、类型、单元、构建和真实 WebGPU 门禁。
