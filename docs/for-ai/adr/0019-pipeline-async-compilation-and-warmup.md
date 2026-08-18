# ADR 0019：Pipeline 异步编译与预热生命周期

- 状态：Accepted
- 日期：2026-07-17

## 背景

内置 renderer、GUI、post-process 和实例化 compute pass 曾在 `prepare()` 或首次遇到变体时同步创建 pipeline。随着 PBR、Fog、shadow、skinning 与 shader feature 增长，同步编译会把驱动编译成本放进首帧或首次显示材质的关键路径，并让编辑器 viewport 表现为无进度的卡顿。

`prepare(engine): void` 同时承担 bind group layout、shader module、buffer 等同步 GPU 对象初始化，已有系统和资源恢复流程依赖这个契约。为异步 pipeline 编译把整个 `prepare()` 改成 Promise 会扩大生命周期状态空间，也会破坏现有同步记录路径。

## 决策

1. 保留所有 renderer 的同步 `prepare(engine): void` 契约；所有 `BaseRenderer` 实现（含 GUI）禁止在 `prepare()` 中同步创建 render/compute pipeline。post-process pass 同样只在 `prepare()` 创建 module、layout 和其他轻量资源。
2. `PipelineWarmupPlan` 是独立的异步生命周期：renderer/system 通过 `contributePipelineWarmup(plan)` 声明常用变体，plan 负责任务去重、并发限制、取消、进度和最终状态。
3. `Scene.createPipelineWarmupPlan()` 从已安装 system 构造一次场景计划；资产和场景完成装配后调用 `Scene.warmupPipelines()`。普通同步渲染路径继续保留按需创建，作为未预热变体的正确性后备。
4. render/compute pipeline 分别使用 `GPUDevice.createRenderPipelineAsync()` 和 `createComputePipelineAsync()`；不支持异步方法的实现可回退到同步创建，但仍经过相同 warmup 生命周期。
5. 异步编译结果必须写回 renderer 原有的 LRU pipeline cache 或 pass 自身的 pipeline 引用，并使用与同步按需路径完全相同的 key。预热完成后的首帧只能命中同一份结果，不能维护第二份 warmup cache。
6. 每个 renderer 累计记录 cache hit、miss、同步/异步创建数、失败数、pending 数、创建耗时与 cache size。诊断是观测数据，不参与渲染正确性决策。
7. 编译失败统一为 `E_RENDER_PIPELINE_COMPILATION_FAILED`，携带 renderer、pipeline key、任务 label、原始 cause 与 retry recovery；计划继续收集并结束其他任务，最终拒绝首个结构化错误。
8. 编辑器启动 viewport 前等待常用 shader 预热，并显示完成数、总数和当前变体。失败时展示结构化错误，不进入一个已知 pipeline 不完整的 viewport。

## API 分层

- `PipelineWarmupPlan`、进度/运行选项、participant 协议和 `Scene.warmupPipelines()` 是稳定的应用生命周期能力。
- `createRenderPipelineAsync()`、`createComputePipelineAsync()`、`BaseRenderer` 的 warmup helper 与 cache 诊断属于低层渲染实现，只从 `experimental`/内部 renderer 入口暴露。
- stable API 暴露“声明并执行预热”的能力，不暴露具体 GPU pipeline cache 容器。

## 后果

- 常用变体的驱动编译从首帧移到可观察、可取消的加载阶段。
- 自定义 system 可以参与同一个场景计划，内置 renderer 不需要知道编辑器或资产加载器。
- 未列入计划的长尾变体仍可能首次同步编译；后续应基于 cache miss 诊断扩充场景/材质变体收集，而不是无上限枚举全部组合。
- GUI、post-process、实例剔除和深度排序 compute pipeline 使用同一计划，因此场景 warmup 的完成状态覆盖完整内置渲染链。
- `renderer-prepare:check` 对所有 `BaseRenderer` 实现执行覆盖门禁，防止新增 renderer 遗漏 warmup 或在 `prepare()` 中重新引入同步编译。
