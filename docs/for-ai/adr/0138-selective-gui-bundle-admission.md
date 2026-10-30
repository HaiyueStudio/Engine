# ADR 0138：GUI 独立 pass 包体准入及固定七报告复核

- 状态：接受，2026-10-29；用户明确批准两份文件补入 G13 及本轮严格哈希复用。
- 范围：仅 0.2.2 当前 2D UI 完整反射制品的 gzip 容量；继承 ADR 0135，不扩大任何性能或设备例外。

## 问题

196 次剩余捕获完成，七报告原始审计与四类运行时重建通过。完整全局门禁在 Stage 9 包体检查停止：当前 2D UI gzip 为 4,746 B，旧单体导出上限为 4,742 B。

独立内容审计将当前七个 pass 与编译器完整 artifact 深比较，并确认各独立导出与完整 artifact 使用同一对象。相同内容的单体导出为 4,606 B，独立 pass 导出为 GUI 按需装配增加 140 B gzip；未复制 shader 或反射实现。实际 tarball 与受检 JS 逐字节一致。2D 加 simple3d 总 gzip 为 11,846 B，低于原 12,000 B。

## 决定

1. 历史 `stage9-contract.json` 完整保留，包括 4,742 B 观测上限、53,787 B raw 及 12,000 B 总容量。当前 `shader-cost-budgets.json` 单列 2D UI gzip 容量 4,800 B，实测余量 54 B；检查脚本使用当前准入，保留 raw、总容量、编译器隔离及全部其他检查。
2. 本次 G13 具名扩展仅 `shader-language/shader-cost-budgets.json` 和 `shader-language/scripts/check-stage9-bundle.mjs`。运行时、生成器、WGSL、公开 API、四包字节及所有性能／画质／资源预算不改。
3. 严格限定复用本轮七报告共 580 次 renderer 捕获，以及已接受的 HYA、布局、corpus、真实 IME／手柄数据。`scripts/g13-stage9-reuse-policy.mjs` 固定原失败 run、全部七报告及两份修复文件的完整 SHA-256；主目录和 LF 检出分别核对原始字节，不归一化哈希。所有原失败、检查、样本和预热保持。
4. ADR 0126 默认复用规则仍有效。该例外要求 0.2.2、具名报告及 capture revision 精确匹配、两份文件均为批准字节；其余变更只能是现行允许的具名验收入口及文档。源码、采样器、生成器、冻结性能预算或其他报告变更均不在范围内。
5. 重新独立回读全部原始捕获、输入及包哈希，四类运行时重建逐字节匹配后，完整重跑全局门禁及无发布演练，最后复核四包。不得只跳过已失败子项或宣告门禁通过。其他新增硬失败继续停止，保留日志，不自动重试。

## 结论与证据

隔离策略测试及实际包体检查通过，补丁经用户批准应用；这不授予完整 Windows、G13 或发布资格。当前执行状态见 [G13 验收入口](../../../review/engine-0.2.2/README.md)。独立内容审计与原始失败保存在 `artifacts/engine-0.2.2/g13/stage9-admission-proposal/`、`windows-remaining-1793238578178-59eefefb/`。Apple 设备资格仍待补齐，不发布、不推送、不提升基线。
