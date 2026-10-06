# G09 FrameGraph 验收索引

本目录记录 G09 各子阶段的实现与证据。真实依赖、裁剪、临时纹理复用、计划缓存、安全附件操作与按需诊断已实现；完整 G09 与持续稳定性资格尚未完成。

- [重启后复现](post-reboot-reproduction.md)与[证据索引](post-reboot-checks.json)：2026-10-06 Intel 4/4 失败、AMD 2/2 通过；四个 Intel 样本窗口均有内核 GPU 超时与重置信号。
- [Intel GPU 重置追查](intel-gpu-reset-investigation.md)与[证据索引](intel-gpu-reset-checks.json)：系统报告确认测试时段的集显挂起/重置；启动参数、AO 分段简化和带窗口模式均未消除异常。
- [局部修复审计](local-fix-audit.md)与[检查索引](local-fix-checks.json)：设备丢失后的读回生命周期修复、双 GPU 回归及未采用的候选方案；集显异常仍未解决。
- [同提交读回与已知答案对照](atomic-readback-investigation.md)：资源保留、固定数据/图案、包装范围隔离和双 GPU 诊断。
- [同提交对照证据索引](atomic-readback-checks.json)：Chrome 154/156 共 96 个会话、原始数据哈希及映射失败重分类；G09 仍未通过。
- [验收异常追查](acceptance-investigation.md)：单像素覆盖证据、A0/B4 对照及尚未证实的触发条件。
- [验收追查证据索引](acceptance-investigation-checks.json)：读回矛盾、执行标记、超时诊断及最终兼容矩阵，保留全部失败。
- [阶段六回归接线审计](comparison-regression-audit.md)与[检查记录](comparison-regression-checks.json)：完整资格仍未完成。
- [阶段五诊断与示例审计](diagnostics-audit.md)：按需单帧捕获、API 评审、双设备专项和保留的集显差异。
- [阶段五检查与源码指纹](diagnostics-checks.json)。
- [安全附件操作与计划缓存审计](plan-cache-audit.md)：阶段四实现、消融验证与混合尺寸描边生命周期修复。
- [阶段四检查与源码指纹](plan-cache-checks.json)：专项通过与完整兼容性未通过分别记录。
- [临时纹理复用审计](resource-reuse-audit.md)：物理资源收益、双 GPU 验证及保留的集显偶发记录。
- [临时纹理复用检查与源码指纹](resource-reuse-checks.json)。
- [依赖与裁剪审计](dependency-culling-audit.md)：实现范围、对照和验证记录。
- [检查摘要与源码指纹](dependency-culling-checks.json)。
- [启动源码指纹](dependency-baseline.json)：本次实现前基线，无性能采样。
- ADR：[帧计划活跃根与后处理读写裁剪](../../../docs/for-ai/adr/0111-framegraph-dependency-culling.md)。

完整两设备性能人口、集显偶发像素异常追查和 G05 最终资格仍为后续工作；计划缓存与附件操作的当前检查状态见阶段四审计。
