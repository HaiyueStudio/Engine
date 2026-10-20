# 运行时所有权约束

M2.5 已完成，旧 Goal 输入、顺序和交接过程见[阶段结论与原文归档](../../../review/m025/README.md)。本目录保留架构约束；当前 API、格式和预算以现行声明、配置及后续 ADR 为准，不能套用旧阶段的版本冻结值。

建议阅读顺序：

1. [Owner matrix](owner-matrix.md)：Shader、逻辑计划、执行、资源与 async 的唯一 owner。
2. [验证边界](verification-contract.md)：旧阶段冻结的证据与兼容协议；不作为重新执行已完成 Goal 的命令。
3. [Deferred capability registry](deferred-capabilities.md)：M2.5 当时未准入的范围；后续变更按对应 ADR 和[当前能力准入](../capability-admission.md)判断。

## 保留的边界

- shader-language 拥有生产 shader source／schema 与生成；engine 消费 private generated contract。
- 逻辑计划编译与实际 target 解析、pass 执行、submission 分开，不能重复拥有依赖和生命周期决策。
- 资源由 device／renderer／processor 等明确 owner 管理；异步完成必须校验 owner generation，跨 view scratch 按调用隔离。
- 通用 Worker／abort／priority／clock 由共享 substrate 拥有；具体 worker source 留在 capability owner。
- JS ECS 保持权威状态；派生批量后端只能按当前准入合同添加，旧候选 benchmark 不构成实现授权。

相关决定保留在 ADR 0074–0079；新增架构变化通过后续 ADR 表达，不改写旧决定或重新打开阶段交接记录。
