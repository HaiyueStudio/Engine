# M2.5 运行时收敛结论

## 问题

旧 Shader、pass 执行、renderer、Worker／async、Compute／GUI 路径存在重复 owner 和阶段交接记录。M2.5 已于 2026-08-17 完成；旧 Goal 顺序和审计缺口不再作为当前待执行任务。

## 结论与解决方法

- Shader source、schema、WGSL／reflection 生成由 shader-language 拥有，runtime 消费生成合同。
- 逻辑计划、实际 pass 执行、GPU 资源与异步生命周期保持各自唯一 owner。当前维护入口为[运行时所有权约束](../../docs/for-ai/runtime-convergence/README.md)及 [owner matrix](../../docs/for-ai/runtime-convergence/owner-matrix.md)。
- Worker／async plain contract、GUI layout／serialization 和 Compute ordering 不再由每个 consumer 自建重复状态机。
- JS ECS 保持权威状态；SceneBatch／WASM 的历史回放没有达到保留条件，见 [WASM no-go](g07-wasm-no-go.md)。新增后端仍需新的产品证据和准入决定。

## 保留的证据

[原交接、审计、API／包体评审和完成记录](../archive/engine-process-history-20261016.json)保留原字节、路径和失败结果，不作为当前版本的验收证明。原 fixture 和测量 JSON 继续位于本目录：

- [Planning identity](g01-planning-baseline.json)与[Shader cost diff](g02-shader-cost-diff.json)。
- [Pass history](g03-pass-history-fixtures.json)与[late async fault](g04-late-async-fault-report.json)。
- [Worker protocol](g05-worker-protocol-schema.json)。
- [Compute resource access](g06-compute-resource-access-fixtures.json)与[GUI layout parity](g06-gui-layout-parity.json)。
- [SceneBatch／WASM 回放](g07-scene-batch-benchmark.json)。

当前包、API、格式、预算及发布资格以现行配置、声明和对应 ADR 为准，不重新执行已完成的 M2.5 交接流程。
