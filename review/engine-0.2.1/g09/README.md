# G09 FrameGraph 验收索引

本目录记录 G09 各子阶段的实现与证据。真实依赖、裁剪、临时纹理复用、计划缓存、安全附件操作与按需诊断已实现；完整 G09 与持续稳定性资格尚未完成。

- **优化后复采（2026-10-07，19:14 完成）**：[CPU 通过与 GPU 状态差异](gpu-state-stability.md)及[检查索引](gpu-stability-checks.json)。完整 28 项捕获独立重算；CPU 单灯/八灯回归 4.42%/2.56%，通过原 5% 预算。八灯 A0 第三轮 GPU 耗时显著变短，伴随高结束频率，三轮 GPU 稳定性失败，整体基线仍不合格。已验证约 6–8 分钟的独立 GPU 定向诊断入口，待采集计时窗口内的核心/显存频率和 P-state。

- **首轮完整 v3 结果（2026-10-07）**：[共同稳态、新基线与 CPU 回归](controlled-sampling-result.md)及[检查索引](controlled-sampling-checks.json)。28/28 捕获独立核验，共同预热选定 6000 帧，首轮 A0 同机基线稳定；当时 B4 单灯/八灯 CPU P95 回归 5.31%/6.96%，GPU 指标通过。后续重复结构序列化优化及复采结论见上，不覆盖此历史失败。

- **CPU record 后段诊断（2026-10-07）**：[调用栈、GC/JIT、阶段计时与电源对照](cpu-record-diagnosis.md)。累计十次长诊断。新增三段独立 A0 对照：最低处理器状态 100% 时后半段 CPU P95 为 0.495–0.500 ms，恢复原方案后峰值再现。共同主机条件接入 [v3 协议](../../../docs/for-ai/adr/0120-g09-controlled-cpu-power.md)后完整校准通过，当前剩余 CPU 回归见最新结果；原 5% 预算不变。

- **独立采样协议（2026-10-07）**：[ADR 0118](../../../docs/for-ai/adr/0118-g09-cold-steady-sampling.md)定义先校准、再冻结、最后以全新人口重建同机基线的流程；保留原 5% 回归预算及旧门禁记录。[历史 v1/v2 与 v3 入口记录](unattended-sampling.md)保留共同稳态失败、服务/电源恢复及工程修复经过；最新 v3 全量结果见上。

- **性能验收进展（2026-10-06 晚）**：[逐进程归因与解决路径](performance-host-diagnosis.md)。已防止索引中途重启，完整预检取得 12/12 次捕获并通过 24 次主机检查；仍因旧基线八灯 CPU 稳定性失败而不合格。追加 18 次三轮预热校准，保留 3 次后台负载失败（含火绒/Codex），尚未证明统一稳态边界。正式口径未改；Search 原设置已恢复，测试进程无残留。

- **当前合同（2026-10-06）**：[硬件范围修订与后续验收](hardware-scope-update.md)及[检查索引](hardware-scope-checks.json)。用户批准将旧 Intel Gen9 降为非阻塞扩展兼容；Windows 独显 Chrome＋Edge 或 macOS Apple/AMD Chrome 完成一条路径。Windows 正确性与 112 次生产分辨率对照通过；完整 Forward 人口已取得，当前性能资格仍未通过。以下修订前失败与身份保持历史原状。

- [Windows 对照与集显测试准备](windows-reproduction.md)与[检查索引](windows-checks.json)：NVIDIA 上 Chrome/Edge 各 32/32 通过；Windows 测试入口已修复，本机 Intel HD 630 尚未枚举，集显复测仍待启用设备。

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

所选原生路径的完整性能人口与 G05 最终资格仍为后续工作；旧 Intel 集显异常保留为非阻塞兼容调查。计划缓存与附件操作的历史检查状态见阶段四审计。
