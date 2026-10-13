# ADR 0122：以能力结构和公开覆盖验收发布包

- 状态：Accepted
- 日期：2026-10-11
- 部分替代：ADR 0085 / 0106 沿用的包文件数量硬上限；原能力准入、API、字节预算和增长储备规则继续有效。

## 决策

用户要求检查 extensions 的实际实现、功能拆分和稳定能力覆盖，并明确文件数不应是发布硬卡点。文件拆得多可能来自必要的声明依赖和独立职责；总数不能证明实现冗余或缺少封装。

1. 四个公共包统一采用 package budget schema 4。保留历史已审查文件数和每次 tarball 的真实文件清单、数量及哈希，将文件数标记为 `observe-only`；删除数量上限和数量增长额度。压缩/解压字节上限与已有 focused consumer 上限不变。
2. extensions 的稳定能力沿用 `public-api-capability-budgets.json` 的显式分组。每个稳定入口须有实际发布的 JavaScript/类型目标和从该入口导入的独立消费场景；声明边界检查从该分组推导，避免手工名单漏检。
3. 独立安装后的 TypeScript 检查覆盖四个公共包的所有声明入口，`skipLibCheck=false`。ESM 加载、API 基线、依赖边界、文件白名单、可重复打包和现有功能测试继续阻塞发布。
4. 保持根入口轻量、能力按需导入。稳定能力通过对应 facade 暴露；内部 renderer、sampler、transport、资源 owner 不因存在实现文件就自动成为稳定 API。ray tracing 和 experimental Worker 等不因此升级稳定等级。
5. 自建扩展系统有明确所有权：安装事务同时登记销毁，卸载和失败回滚释放资源；借用的编辑器系统不由借用方销毁。

## 实施与验证

[extensions 实现与 API 评审](../../../review/api/extensions-capability-review.md)记录功能归属、覆盖缺口、生命周期修复、包体测量和验收证据。旧 `202 > 200` 失败保留为历史报告，使用新合同重新打包验证；不能仅改写旧报告状态。

该决策不改变 G09 的性能协议、5% 回归预算、设备要求或完整验收状态。
