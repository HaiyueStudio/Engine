# 独立库发布边界

## 问题与结论

旧 0.1.1 检查将 UI／Editor／Games 的集成就绪与 Engine 库发布混在一起。独立发布范围已经由 [ADR 0105](../docs/for-ai/adr/0105-independent-library-release-gates.md)和[当前发布清单](api/release-manifest.json)拥有；兄弟仓库各自发布，不能据其中一方就绪宣称 Engine 已通过发布验收。

## 解决方法

库发布按独立包、声明／导出、消费端、预算和原生资格验证；Studio 集成检查保留自身职责。新增能力及下载成本按当前配置、[ADR 0106](../docs/for-ai/adr/0106-release-0.2.0-capability-budgets.md)和后续 ADR 管理，不再执行旧候选排除清单。

当前状态见 [Engine 0.2.1](engine-0.2.1/README.md)。[原拆分检查与旧候选过程](archive/engine-process-history-20261016.json)保留原字节，旧本机检查不充当新版本正式 runner 证据，也不代表已经发布。
