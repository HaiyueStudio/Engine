# Extensions：问题、方法、结论

依据 [ADR 0122](../../docs/for-ai/adr/0122-package-capability-structure-review.md)，实现按职责/依赖/稳定能力评审，文件数仅作观察；不为减少文件数合并模块或扩大根入口。

| 问题 | 方法 | 结论 |
| --- | --- | --- |
| glTF/Spine/Tilemap插件共用闭包，卸载只移出World而未销毁自有system | 每次安装独立owner，先登记rollback，明确自建/借用，销毁幂等；失败和设备监听一并清理 | 原生命周期回归及真实WebGPU资产验证通过；旧失败日志保留 |
| 稳定入口手工名单遗漏能力，发布包消费和类型检查不完整 | 从能力分组自动推导稳定入口；focused consumer覆盖已承诺能力，独立检查四包全部声明入口 | 当前来源为[能力预算](../../config/public-api-capability-budgets.json)和[包策略](../../config/engine-package-budget.json)，未登记新稳定能力仍应失败 |
| 包内声明/共享chunk数量被误作功能数或失败依据 | 保留私有职责拆分，清理不可达声明，约束包体字节、依赖、公开类型、按需闭包及内容白名单 | 不设包中文件数硬门禁；root和experimental边界由API规则维护，不把内部sampler/worker/renderer自动升为stable |
| 动画入口静态引入OpenType解析器 | 后续已按[独立评审](animation-opentype-loading-review.md)改为字体资源触发按需加载 | 原“未来可评审”的过程建议已被现行实现取代；不再当作未处理事项 |

原复核没有新增公开符号。原完整包、类型/示例和GPU资源检查绑定于[机器记录](extensions-capability-checks.json)，当时通过不替代新候选资格。原消费测量、测试计数、预算探测及环境重试见[校验归档](../archive/engine-review-process-20261020.json)，不修改失败判定或既有预算。
