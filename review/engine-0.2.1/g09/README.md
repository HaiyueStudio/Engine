# G09 FrameGraph 验收索引

本目录记录 G09 各子阶段的实现与证据。真实依赖、裁剪、临时纹理复用、计划缓存、安全附件操作与按需诊断已实现；完整 G09 与持续稳定性资格尚未完成。

- **单灯连续 GPU 状态诊断入口（2026-10-12）**：[固定对照与运行方式](single-light-gpu-state-diagnostic.md)及[工程检查](single-light-gpu-state-diagnostic-checks.json)。保留 v5 单灯负载、B8、三轮 AB/BA/AB，双方只共同增加 200 ms 连续 GPU 状态观察；诊断不直接生成基线。真实观察器及三组画面对照通过；工程计时尝试因其他构建的高 CPU 负载等待超时，已恢复设置，完整六次独立诊断待空闲执行。复核状态后再做两场景校准和全新三轮基线，原 5% 预算不变。

- **v5 独立校准完成（2026-10-12，13:08）**：[结果](gpu-warmup-calibration-v5-result.md)及[独立复核](gpu-warmup-calibration-v5-result-checks.json)。20 次捕获完整，CPU 共同候选 12000 帧；单灯 B4 第三轮全尾段 GPU 跨轮 spread 超过 20%，GPU 校准失败，新基线阻断。六组画面对照零差异，设置恢复、无锁屏和采样退出已核验；尚缺执行期间连续 GPU 状态证据，不以增加预热或删除慢轮放行，原 5% 回归预算不变。

- **共同 GPU 预热与新基线入口（2026-10-12）**：[v5 协议及操作](gpu-warmup-calibration-v5.md)及[机器复核](gpu-warmup-calibration-v5-checks.json)。双方统一八帧批量完成，独立选择共同 CPU/GPU 预热后冻结，再采三轮新基线；原 5% 回归预算不变。16 次原生工程捕获、42672 GPU 帧及六组零差异画面对照通过，恢复与进程退出已复核；111 项 FrameGraph 策略、全仓测试/类型/构建通过。独立完整校准及新基线尚待用户退出应用后运行 `D:\HaiyueStudio\start-g09-calibration.cmd`。

- **独立长诊断完整结果（2026-10-12）**：[结果与剩余预热问题](batch-completion-long-result.md)及[机器复核](batch-completion-long-result-checks.json)。8/8 次、96 万测量帧、每次至少 90 秒且全程无锁屏；设置与资源恢复通过。B8 四次均无既定阈值慢帧，S8 有 1854 个主绘制慢帧、47 个长慢段，其中 46 段未观察到外部调度重合。约 686 万个事件完整复核；A0/B8 一轮首 300 帧仍有过渡波动，需要共同 GPU 预热校准和新基线，原 5% 预算不变。

- **独立长诊断构建过期（2026-10-12）**：[现场、重建与提前预检](batch-completion-stale-build.md)及[机器复核](batch-completion-stale-build-checks.json)。CMYK 合入导致输入指纹变化，首组采样前被正确拒绝；设置和追踪均已恢复。独立重建的四个 B4 JavaScript 文件逐字节相同，刷新当前输入绑定；新增启动前 A0/B4 完整性检查，原采样期检查保留。86 项 FrameGraph 策略及原生入口专项通过；未重跑长采样，原 5% 预算不变。

- **长诊断入口权限复核（2026-10-11）**：[现场与提示修正](batch-completion-permission-entry.md)及[机器复核](batch-completion-permission-entry-checks.json)。用户管理员权限已通过，实际由后台应用检查阻止启动；新增独立权限提示、启动记录和只读检查，验证真实 CMD 与隐藏 worker 的权限继承。工程检查未启动采样或修改设置，原长诊断协议及 5% 预算不变。

- **动画文本按需加载（2026-10-11）**：[实现与合同评审](../../api/animation-opentype-loading-review.md)及[机器复核](../../api/animation-opentype-loading-checks.json)。OpenType 随实际字体资源准备加载，Animation2D / HYA 状态机初始 gzip 分别减少 43.59% / 42.16%，原完整消费端与整包字节上限保留。1,468 项全仓测试、98 个示例构建、独立发布包和浏览器字体像素验证通过。单文件 IIFE 仍内联；这不代表 G09 完整性能资格，5% 预算不变。

- **Extensions 结构与发布复核（2026-10-11）**：[实现/API 评审](../../api/extensions-capability-review.md)及[机器复核](../../api/extensions-capability-checks.json)。按用户要求将包文件数改为观察指标，原字节预算保留，补齐 14 个稳定入口的独立消费和四个包全部 66 个声明入口的检查；修复 glTF、Spine、Tilemap 自建系统的销毁与失败回滚。新发布包门禁通过，1,460 项全仓测试及 98 个示例构建通过。原文件数失败保留；这不代表 G09 完整性能资格，原 5% 预算不变。

- **loaders.gl 版本收紧（2026-10-11）**：[依赖评审](../../api/loaders-gl-dependency-review.md)及[机器复核](loaders-dependency-checks.json)。四个直接声明统一固定 4.4.4，显式 core 约束阻止 peer 漂移；全新 Engine 消费者的五个运行时包全部为 4.4.4。1,446 项全仓测试、类型/API 检查、98 个示例构建通过。发布包安装与消费通过，但 extensions 原有 202/200 文件数问题仍使总门禁失败，预算不变。B4 重建的四个 JavaScript 文件逐字节相同，已刷新锁文件变动后的当前构建输入绑定；独立长诊断和完整性能资格仍待完成，5% 预算保持。

- **完整验收推进（2026-10-11）**：[F0–F8 场景登记与预检](acceptance-preflight.md)及[机器复核](acceptance-preflight-checks.json)。60 个场景、Windows 两浏览器 224/224 次正确性捕获及原始数据复核通过，72 组 A0/B4、100 个视图画面差为 0；F0 仅断言显示输出。1,446 项全仓测试、98 个示例重新构建通过，重建影响的辅助专项另行复核。性能、消融及独立长诊断仍待完成，5% 预算不变；全新包消费另发现 loaders.gl 依赖版本不可用，保留失败。

- **长诊断启动中断（2026-10-11）**：[现场与外部入口](batch-completion-launch-interruption.md)及[复核记录](batch-completion-external-entry-checks.json)。确认弹窗后，后台停在等待 ChatGPT 退出阶段，随后消失；没有正式样本、没有设置残留。改为先退出聊天应用，再从资源管理器手动运行根目录 CMD，应用仍在后台则立即拒绝启动。采样协议及 5% 预算不变。

- **延长批量完成观察（2026-10-10）**：[设计与新入口](batch-completion-long-diagnostic.md)及[复核记录](batch-completion-long-checks.json)。双方每次固定 12 万测量帧并要求至少 90 秒，共 8 次；保留 8 帧上限与原 5% 预算。新增锁屏审查和大结果传输修复；工程验证不作性能资格，独立长矩阵待运行。

- **批量完成完整结果（2026-10-10，11:56）**：[结果与锁屏补救](batch-completion-full-result.md)及[复核记录](batch-completion-full-result-checks.json)。8/8 次、12 万帧完整，B8 四次主要处于 P0 且未出现原阈值慢帧；S8 仍有 7 个长慢段。Security 日志发现两次锁屏，6 组 GPU 测量受影响，整批不满足未锁屏条件；B8 仅约 12 秒也不足以证明长期稳定。用户已关闭屏保恢复登录，另加配置预检和运行期间锁屏审查；未建基线，5% 预算保持。

- **固定在途上限的批量完成（2026-10-10）**：[设计、验证与新入口](batch-completion-diagnostic.md)及[复核记录](batch-completion-checks.json)。S8/B8 共用 8 帧上限及整批完成/读回，仅切换逐帧显式等待；11 项专项、四组原生短采样、两组单帧尾批及故障恢复通过。独立 8 次、12 万帧矩阵待运行，较短运行时长不能证明慢段消失；5% 预算保持。

- **主绘制完整单变量矩阵（2026-10-10，10:14）**：[结果与后续边界](main-pass-full-result.md)及[复核记录](main-pass-full-result-checks.json)。12/12 次、18 万帧完整；W1 将等待移入读回，R1 未产生双方一致的改善，所有捕获仍有持续慢段。25 段中 23 段无外部重合或所查分页事件；250 个输出尖峰均有确认的外部活动。A0/R1 两次升频伴随桌面活动，未重现延迟 GPU 信息收集子进程。设置恢复、无采样残留；未建立新基线，5% 预算保持。

- **主绘制矩阵首轮中断（2026-10-09，22:06）**：[结果](main-pass-partial-result.md)及[复核记录](main-pass-partial-result-checks.json)。仅完成 1/12 次 A0/C0；下一次前检测到 Codex/ChatGPT，整批保留 failed。15000 帧复现两段共 72 帧主绘制变慢，同期出现核心频率下探、无外部 GPU 区间重合；37 个输出尖峰均与 dwm 重合。尚无 W1/R1/B4 对照，不能判定干预效果；设置恢复、无采样残留，5% 预算不变。

- **主绘制启动器修复（2026-10-09）**：[原因、恢复与新行为](main-pass-launcher-fix.md)及[检查记录](main-pass-launcher-fix-checks.json)。原入口后台启动后立即退出、缺少防重，导致两份任务重叠；两次均未取得样本，失败和恢复错误保留，原设置确认恢复并清理重复临时方案。已增加启动确认弹窗和跨进程独占保护，原 CMD 转接到修正版；测量协议和 5% 预算不变。

- **主绘制单变量诊断已准备（2026-10-09）**：[实验设计与入口](main-pass-single-variable-diagnostic.md)及[工程检查](main-pass-diagnostic-checks.json)。A0/B4 共用 C0、仅取消采样等待 W1、仅每 8 帧读回 R1，固定反向平衡 12 次捕获；本机锁频接口不可用，频率只作共同观测。六组短验证、逐帧归属和故障恢复通过，资源回收通知保持；独立全量矩阵尚未运行，原 5% 预算不变。

- **信息收集独立对照（2026-10-09，20:18）**：[本轮结果](gpu-info-control-result.md)、[整批复核](gpu-info-control-result-checks.json)、[主绘制事件](gpu-main-pass-context-checks.json)及[完成通知验证](gpu-completion-notice-checks.json)。B4 因 Codex 在采样结束前重新打开而保留 failed；A0 不再出现延迟信息收集进程或 P0，但仍有 10 个桌面任务重合尖峰和两段共 139 帧的主绘制变慢。后者没有同期外部调度包或所列分页事件，原因尚未查明。已补安全结束通知并验证恢复；暂不重复同批，原 5% 预算保持。

- **独立调度归因（2026-10-09，19:23）**：[结果与修复对照](gpu-scheduler-result.md)、[独立复核](gpu-scheduler-result-checks.json)及[新入口检查](gpu-info-control-checks.json)。两组均在 Chrome 启动约 120 秒后出现短时 GPU 信息收集进程并升频；单参数工程对照未再出现该进程或 P0。63 个输出尖峰全部与桌面 GPU 活动重合。已准备关闭延迟收集、隐藏控制台的独立反证入口；原全量失败和 5% 预算保持。

- **v4 八灯阶段诊断完成（2026-10-09，18:35）**：[阶段结果](gpu-v4-phases-result.md)及[独立复核](gpu-v4-phases-result-checks.json)。六轮 14400 帧完整，GPU 测量阶段均观察为 P8/405 MHz；发现稳定频率下的 SceneOutput 尖峰，且旧 A0 也有同类现象。延长预热或合并更多样本均不能据此作为修复；下一步用 GPU 调度记录归因，原 v4 失败和 5% 预算保持。

- **v4 全量完成（2026-10-09，16:33）**：[校准与新基线结果](controlled-gpu-v4-result.md)及[检查记录](controlled-gpu-v4-checks.json)。28/28 项独立重算，共同预热 18000 帧；CPU 单灯/八灯 +2.86%/+2.73% 通过原 5% 预算。八灯 B4 GPU 三轮 1.339/0.979/0.288 ms，跨轮稳定性失败，完整基线仍未通过；所有临时设置恢复。后续仅运行约 25 分钟的八灯阶段诊断，入口见结果记录。

- **独立 GPU 对照完成（2026-10-09）**：[稳定性复核与 v4 新基线入口](gpu-power-closed-result.md)及[检查索引](gpu-power-closed-checks.json)。六轮、14400 个测量帧完整；未发现指定后台程序，全部固定窗口为 P8/405 MHz，三轮 GPU spread 约 3.27%/3.08%。新条件已纳入 v4，正常与故障恢复通过；完整校准和全新基线待独立运行，原 5% 预算不变。

- **重启后验证（2026-10-09）**：[设备恢复与 GPU 电源对照入口](post-reboot-gpu-power.md)及[检查索引](post-reboot-gpu-power-checks.json)。582.78 设备、Chrome 设置保存/恢复和 Chrome/Edge 16 项原生正确性通过；正常与故意中断路径均恢复 CPU/GPU 设置。独立六轮 GPU 状态对照待执行，尚未证明稳态，5% 预算不变。此前安装器收尾错误保留。

- **驱动恢复与缓存迁移（2026-10-09）**：[582.78 恢复及接口验证](nvidia-clean-install.md)。官方清洁安装在旧组件清理阶段失败，随后 Windows PnP 成功安装同一官方驱动；设备正常，Chrome 设置写入/回读及两种恢复路径均通过。pip/npm 缓存已迁至 D 盘。此项为重启前记录；重启后进展见上，5% 预算不变。

- **驱动保存故障（2026-10-09）**：[控制面板与 API 拒绝保存的诊断](nvidia-settings-save-failure.md)。普通文件访问与保存锁正常，显示配置服务重启无效，原样保存/导出也失败；未确定数据库损坏。现有配置已备份；用户已授权，后续状态见 [582.78 清洁安装与空间处理](nvidia-clean-install.md)。

- **GPU 状态诊断（2026-10-09）**：[六轮连续频率与逐帧结果](gpu-state-closed-result.md)及[检查索引](gpu-state-closed-checks.json)。全部六组捕获完整；相同 A0 在 P8/显存 405 MHz 与 P0/4006 MHz 下分别约 1.01 ms 和 0.29 ms，确认跨轮 GPU 状态不可比。Epic 全程在后台，本轮保留 failed，不能作为安静验收。已补启动前后台预检；Chrome 专属电源控制在驱动保存接口报错，原设置未变，短对照尚不能开始。5% 预算不变。

- **优化后复采（2026-10-07，19:14 完成）**：[CPU 通过与 GPU 状态差异](gpu-state-stability.md)及[检查索引](gpu-stability-checks.json)。完整 28 项捕获独立重算；CPU 单灯/八灯回归 4.42%/2.56%，通过原 5% 预算。八灯 A0 第三轮 GPU 耗时显著变短，伴随高结束频率，三轮 GPU 稳定性失败，整体基线仍不合格。已验证约 6–8 分钟的独立 GPU 定向诊断入口，已完成的独立运行结果见上。

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
