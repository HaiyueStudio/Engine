# 旧版本发布结论

本页压缩已结束的 0.1.1／0.2.0 检查过程。当前发布状态只维护在 [Engine 0.2.1](engine-0.2.1/README.md)；旧版通过不能外推为新版、其他设备或新增能力通过。

## 问题、结论与解决方法

| 问题 | 保留结论 | 解决方法与现行入口 |
| --- | --- | --- |
| Windows 重建及 M02／M2.5 交接包含重复 owner、私有 API 泄露和待修复事项 | M2.5 已完成阶段收敛；早期审计中的缺口不应继续当作当前缺陷 | 按[所有权约束](../docs/for-ai/runtime-convergence/owner-matrix.md)维护唯一 owner；原审计和逐 Goal 验证见归档 |
| 0.1.1 候选把 UI 等兄弟仓库的就绪状态混入 Engine 发布 | 独立库发布边界已拆开；Rive 保持独立开发分支范围 | 以 [ADR 0104](../docs/for-ai/adr/0104-rive-development-branch.md)、[ADR 0105](../docs/for-ai/adr/0105-independent-library-release-gates.md)及[当前发布清单](api/release-manifest.json)为准 |
| 0.2.0 的 AO、跨帧 CPU 基准、像素参考与示例接线曾阻塞验收 | 历史阻塞已有修复和后续验收，不能将早期失败继续列为当前未修复问题 | 保留[修复结论](release-0.2.0-blocker-fixes.md)，具体能力预算及 Shader／灯光范围仍见各自专项记录 |
| 全局验证曾因构建与环境干扰中断 | 2026-09-24，冻结候选 `3639ab0601306dc40601dc6ac9c0e3516f8a6ec8` 完整通过当时的 macOS `release:check` | 保留原失败和最终单次完整通过的独立记录；不拼接失败分项、不放宽预算，也不据此声明已经发布 |

## 证据边界

0.2.0 全局记录仅证明原 Mac／原生 Metal 路径及当时冻结输入。原 CPU `report-only / budget-exceeded`、`baseline-missing`、未登记设备耗时及开发工具链审计告警仍按原报告保留；不改写为所有预算通过或当前供应链状态。

[过程原文与逐文件校验清单](archive/engine-process-history-20261016.json)包含旧候选、验收／修复／演练、Windows 重建、M02 冻结和评审输入。其原始大型采样、许可批准与正式基线均未删除。
