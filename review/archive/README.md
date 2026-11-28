# 历史归档

活动结论见 [Engine 0.2.1](../engine-0.2.1/README.md) 与 [G09](../engine-0.2.1/g09/README.md)。归档中的“当前”“下一步”和预算表述只代表记录当时的状态，不作为今天的执行指令。

| 归档 | 内容 | 校验清单 |
| --- | --- | --- |
| [0.2.1 实施与诊断历史](engine-021-history-20261012.zip) | G01–G09 过程报告、逐次检查数据及本次调整前的 M18 活动计划 | [逐文件路径、字节数及 SHA-256](engine-021-history-20261012.json) |
| [M2.5 与旧版本发布过程](engine-process-history-20261016.zip) | 已结束的交接、审计与 0.1.1／0.2.0 发布检查，以及本次精简／链接维护前的原文快照 | [逐文件路径、字节数及 SHA-256](engine-process-history-20261016.json) |
| [GUI／可选能力与0.2.1评审过程](engine-review-process-20261020.zip) | 32份原文：重复验证叙述、摇杆逐命令日志及本次精简前快照；活动资料只保留问题、方法、结论 | [逐文件路径、字节数及SHA-256](engine-review-process-20261020.json) |
| [0.2.2／0.2.3 验收入口过程原文](engine-review-entry-history-20261102.zip) | 入口整理前的 4 份原文；0.2.2 的已结束阶段时间线与 0.2.3 已被 GUI P2 取代的候选叙述。当前合同、检查 JSON、ADR、许可和原始捕获保持原路径 | [原路径、字节数与 SHA-256](engine-review-entry-history-20261102.json) |
| [技术债审计至 2026-11-26](tech-debt-audit-through-20261126.zip) | F01–F26 的原始问题、已完成修复与历次验收原文；现行审计及简短状态见根目录 TECH_DEBT_AUDIT.md | [原路径、字节数与 SHA-256](tech-debt-audit-through-20261126.json) |
| [F01–F35 修复至本轮复审前的原文](tech-debt-audit-through-f35-20261128.zip) | 保留完整问题、修复和验证原文；F33 specialization 残留与 F36–F42 以根目录现行审计为准 | [原路径、字节数与 SHA-256](tech-debt-audit-through-f35-20261128.json) |
| [F33 残留及 F36–F42 修复前审计](tech-debt-audit-findings-f36-f42-20261128.zip) | 保留原问题、独立复现和失败判定；修复结果见根目录现行审计 | [原路径、字节数与 SHA-256](tech-debt-audit-findings-f36-f42-20261128.json) |

原始运行产物另见[过期运行副本与安装缓存](engine-obsolete-runtime-20261102.md)：D 盘十四批旧 G11 ZIP 与 F 盘六批旧 G13／G10 ZIP64 归档分别保存，均保留原路径、SHA-256 和恢复入口。后续历史大文件按[空间淘汰规则](../../scripts/README.artifact-retention.md)进入冷归档，当前 0.2.3、正式发布包、合同与基线继续保留。

归档保留原字节、失败结果和完整相对路径，已逐文件解包核验；`npm run docs:check` 持续检查归档校验和与清单完整性。上表为文档归档；历史运行产物另按空间淘汰清单保存，展开副本须在回读校验通过后移除。压缩不重写 Git 历史。

查找旧文件时，在校验清单中搜索其原文件名。ZIP 可用资源管理器打开；若需要复核原相对链接，将 ZIP 解压到新的临时目录，保留 `Engine/` 和 `milestones/` 路径。不要解压覆盖工作仓库。大型原始采样按空间淘汰清单和旧归档索引读取或恢复，原报告路径及哈希身份保持。
