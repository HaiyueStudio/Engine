# G09 硬件合同修订与 Windows 后续验收

日期：2026-10-06。用户批准调整合同和门禁后继续实施。G09 仍为 active；本报告不授予正式性能或发布资格。

机器可读的当前指纹、原始文件 SHA-256、命令日志与汇总见 [检查索引](hardware-scope-checks.json)。

## 当前合同

[ADR 0117](../../../docs/for-ai/adr/0117-native-021-hardware-scope.md) 和 [release matrix](../../../config/release-matrix.json) 是当前硬件要求：Windows 原生独显 Chrome＋Edge，或 macOS Apple Silicon/AMD Metal Chrome，完成一条完整路径。旧 Intel Gen9 为 extended 非阻塞兼容范围。

历史 Intel 黑帧、读回异常、系统 GPU 超时/重置及性能失败均保持原状态。新范围不意味着修复，也不把旧双设备证据改标签。旧 G05 AMD 性能失败仍保留；新主机须重新采样，不能与 Mac 数据拼接。画质、灯数、分辨率、样本数、冷却与数值预算均未放宽。

## 门禁迁移

- G09 full 回归 schema 3 绑定新的平台合同及 release matrix 哈希。Windows 要求两个不同浏览器产品；所有既有场景断言保留，且 fallback 字段必须明确为 false。smoke、旧 schema、portable 诊断不可代替 full。
- 裁剪、示例、读回设备丢失回归及 ABBA 黑帧对照采用同一平台策略。powerPreference 不再用作两块物理 GPU 的身份证明。
- fixed A0 builder 从 `21105a2a94e1b811b4c9b03fbca3c6187e1fa771` 导出依赖源码，逐文件核对 Git blob 及 SHA-256。与 B4 复用同一构建函数；桥接仅导出旧有 GaussianBlurPass 和基准捕获/预热/场景解析函数，未修改旧运行时。两版本 package-lock 在对应提交间无差异。
- `verify:framegraph:parity` 预登记 G05 的 13 组静态/动态 room 场景及高质量 1080p GTAO，共 112 个 Windows A0/B4 浏览器会话。保存完整浮点 HDR/LDR 图像并逐分量配对；任何失败终止该人口并保留原始数据。该入口只覆盖这些生产分辨率预检，不冒充 F0–F8 全部验收。

## 默认 Forward 性能预检入口

新增 `verify:framegraph:forward -- --smoke|--full|--plan`，由 `config/framegraph-performance-021.json` 登记当前 NVIDIA/Windows 开发主机。该配置明确只实现既有 G01/G05 Forward 人口的前置回归检查，保留夹具已有后处理，不能冒充 G09 的 effects-off F0 或完整 F0–F8 manifest。先做 1/8 灯 720p 整幅图像对照，拒绝全黑/覆盖缺失，再执行三轮 AB/BA/AB、每次实测 120 秒冷却、120 帧预热、各 300 CPU/GPU 样本；沿用 5% CPU/GPU 回归和原轮次稳定性判定。

记录 CPU 负载与频率、NVIDIA 温度/频率/降频标记及 Windows 电源方案。计时前后背景 CPU 超过 15% 或 GPU 超过 10% 时拒绝该人口；CPU 温度/热限速状态不可得，明确记 unavailable，未伪造 macOS 的 pmset 数据。开发 profile 未注册为正式 release runner，任何结果都保持 performanceQualified=false。

## 本次 Windows 工程与原生验证

GTX 1070 Ti / NVIDIA 560.94，Windows 10 22H2；实际浏览器为 Chrome 153.0.8010.50 与 Edge 154.0.4258.53，D3D11 原生后端。两浏览器均核验 NVIDIA/Pascal、fallback=false。候选为 `release/0.2.1` 的 dirty 开发工作树，未提交或提升发布资格。

| 验证 | 结果 | 原始入口 |
| --- | --- | --- |
| 完整 FrameGraph 兼容回归 | 16/16，两浏览器各 8 项 | [schema 3 report](../../../artifacts/engine-0.2.1/g09/regressions-2026-10-06T10-06-19.274Z.json) |
| 裁剪、导出与副作用保留 | 两浏览器通过 | [culling](../../../artifacts/engine-0.2.1/g09/culling-2026-10-06T10-08-14.595Z/native.json) |
| 读回与设备丢失生命周期 | 两浏览器各 3 项通过 | [readback/device loss](../../../artifacts/engine-0.2.1/g09/readback-device-loss-2026-10-06T10-08-25.005Z/report.json) |
| 示例与按需图诊断 | 两浏览器各 9 项通过 | [inspector](../../../artifacts/engine-0.2.1/g09/inspector-2026-10-06T10-08-30.644Z/native.json) |
| ABBA 同提交黑帧对照 | 48 次捕获、36 组配对通过，最大像素差 0 | [atomic ABBA](../../../artifacts/engine-0.2.1/g09/black-frame-2026-10-06T10-08-51.029Z/report.json) |
| 生产分辨率 A0/B4 对照 | 112/112 会话、56 组配对通过；68 个视图 HDR/LDR 分量差均为 0 | [room/GTAO parity](../../../artifacts/engine-0.2.1/g09/parity-2026-10-06T10-11-49.518Z/report.json) |

工程验证：examples typecheck/定向构建、root typecheck/test/build、53 项 FrameGraph 策略、226 项 performance 策略、32 项最终定向策略、docs/API 通过。全仓 workspace 测试 1,441 项，98 个 fresh 示例构建；模块/职责/prepare/no-rive 检查通过。命令起止时间与退出码分别在 [工程检查](../../../artifacts/engine-0.2.1/g09/windows-v2-engineering-20261006T095359/checks.json)、[原生检查](../../../artifacts/engine-0.2.1/g09/windows-v2-native-20261006T100618/checks.json)和[结构检查](../../../artifacts/engine-0.2.1/g09/windows-v2-structural/checks.json)。

## 四视图资源变化

在既有 `dynamic-128-four-view` 生产分辨率预检中，Chrome/Edge、reference/Tiled 的四组 A0/B4 对照均得到相同结果：

| 预热后分配估算 | 固定旧版 A0 | 当前 B4 | 变化 |
| --- | --- | --- | --- |
| 全部跟踪纹理 | 27 张，126,861,432 B（120.98 MiB） | 15 张，49,447,032 B（47.16 MiB） | 减少 77,414,400 B，约 61.02% |
| 其中 G-buffer | 16 张，103,219,200 B | 4 张，25,804,800 B | 减少 12 张、75% |

减少的字节恰为 `3 × 1280 × 720 × 28`：四组顺序视图的同格式 G-buffer 改为一组物理附件按生命周期复用。四幅 HDR/LDR 输出均逐分量一致。这是预热后资源分配的实测估算，不是驱动驻留显存，也不是三轮性能人口、完整生命周期峰值或 CPU/GPU 耗时收益；计时与稳态归因仍待后续完整验收。原始文件与资源记录见 [生产分辨率对照](../../../artifacts/engine-0.2.1/g09/parity-2026-10-06T10-11-49.518Z/report.json)。

## 保留的失败与修复

首次完整分辨率预检在四视图 A0 已完成 GPU 采样、通过单次 CDP 消息取回全部浮点图像时连接断开。改为按 1 MiB 分块传输并核验完整分量数后，同一场景的数据传输通过；分辨率、场景和像素容差未变。[初次 20/112 后中断的报告](../../../artifacts/engine-0.2.1/g09/parity-2026-10-06T09-26-08.459Z/report.json)保留为传输阶段失败，未判作引擎黑帧，也未确定浏览器内部的具体限制。

Forward 首次 smoke 暴露私有 bundle 与外部场景解析器的 WeakSet 身份不一致。桥接改为导出各版本自身的解析器，未修改旧 A0 运行时。[失败报告](../../../artifacts/engine-0.2.1/g09/forward-2026-10-06T09-44-30.128Z/report.json)及[修复后 smoke](../../../artifacts/engine-0.2.1/g09/forward-2026-10-06T09-46-47.480Z/report.json)均保留；后者是 3 样本诊断，不授予性能资格。

首次 `--full` 在完成两组整幅图像对照、实际冷却 120000.5 ms 后，被 CPU 背景负载 23.4375%（上限 15%）拦截；当时 GPU 0%、52°C、139 MHz，GPU thermal/brake 标记均未激活。[完整尝试](../../../artifacts/engine-0.2.1/g09/forward-2026-10-06T09-48-54.265Z/report.json)没有任何 300 样本计时捕获，不能给出性能增益或回归结论。

最终双浏览器正确性全部结束后，[三次主机空闲复查](../../../artifacts/engine-0.2.1/g09/windows-v2-idle-recheck.json)仍为 38.28%、23.17%、27.19% CPU，GPU 均为 0%。再执行一次当前指纹下的完整入口，像素预检再次通过，实测冷却 120001.16 ms 后 CPU 仍为 23.999%（上限 15%），[重试人口](../../../artifacts/engine-0.2.1/g09/forward-2026-10-06T10-31-07.818Z/report.json)在第一次正式计时前失败，300 样本捕获仍为 0。只读检查发现另一个任务的 `python -m pip install --target .tools/python UnityPy` 仍在运行；未终止其他任务、变更电源方案或放宽门禁。

## 空闲主机的遗留进程检查 — 2026-10-06 18:40

用户确认机器空闲并要求检查无用遗留进程。核对进程命令、创建时间、父子关系及其他任务状态后，发现 PID 19012 的 UnityPy 安装从 16:40 起仍持续运行，5 秒区间中占总 CPU 约 10.34%（接近一个逻辑核心）。未发现 Engine 的 headless Chrome/Edge 或测试 Node 进程残留；已有交互浏览器和预览服务保持运行。

按此次用户指示结束该不再需要的安装；PID 19012 及等待它的 PowerShell PID 7256 均已退出，见[清理记录](../../../artifacts/engine-0.2.1/g09/windows-process-cleanup-20261006.json)。清理后等待并分三次观测，CPU 为 9.15%、9.97%、10.30%，GPU 均为 0%，见[空闲复测](../../../artifacts/engine-0.2.1/g09/windows-post-cleanup-idle-20261006.json)。这解除了一开始就被空闲检查拦截的问题；旧失败人口保留。

随后[重新采样的人口](../../../artifacts/engine-0.2.1/g09/forward-2026-10-06T10-40-52.283Z/report.json)取得 11 次完整捕获，各有 300 CPU/300 GPU 样本，22 次前后 CPU 观测范围为 4.66%–12.11%。第 12 次在计时开始前出现 25.748% CPU，GPU 仍为 0%，人口按原门禁失败：没有补采最后一项并拼接，也没有输出完整资格或预算通过结论。

失败后的[系统级进程检查](../../../artifacts/engine-0.2.1/g09/windows-final-spike-process-check.json)确认安装进程没有重启；Windows `SearchFilterHost`、`SearchProtocolHost`、`SearchIndexer` 合计约占 7.36% CPU。普通权限的进程列表未显示这些服务的完整 CPU 数据，故补用了系统性能计数器。该观测在突增之后，不能证明它解释了当时全部 25.748% 占用；定期启动命令读取进度也可能干扰一秒预检窗口。索引服务不是测试残留，因此先取得用户授权，再执行下述临时暂停对照。

## 临时暂停 Windows Search 的采样 — 2026-10-06 19:31–19:47

用户明确回复“允许，采样后恢复”。包装脚本记录 `WSearch` 原状态 Running、启动方式 Auto，于 19:31:45 确认服务停止；不改变启动方式和电源方案。完整采样在 `try/finally` 内运行，期间只消费现有采样进程的输出，没有另启主机监控或构建命令。失败后服务于 19:47:11 前恢复为 Running/Auto，随后独立查询再次确认恢复，见[服务状态与恢复记录](../../../artifacts/engine-0.2.1/g09/windows-search-paused-20261006T113142/service-state.json)及[独立恢复核验](../../../artifacts/engine-0.2.1/g09/windows-search-paused-20261006T113142/service-verification.json)。

[本轮完整尝试](../../../artifacts/engine-0.2.1/g09/forward-2026-10-06T11-31-45.640Z/report.json)再次通过两组整幅图像对照，取得 7 次各 300 CPU/300 GPU 样本的捕获，其中前 6 次的主机前后检查通过，CPU 范围 5.86%–11.52%。第 7 次（第二轮 `forward-small-1` B4）前测 CPU 13.33%，采样后的 CPU 为 20.949%，GPU 为 0%，超过原有 15% CPU 上限，整组按门禁失败。第 7 次原始数据保留，但不接受为通过项；未执行剩余 5 次、未拼接其他失败轮次，也未计算完整预算通过结论。所有已执行项均实测冷却至少 120000 ms，浏览器临时目录清理均通过。

这次对照表明，仅暂停 Windows Search 仍不足以避免主机负载突增，不能将索引认定为唯一原因。恢复服务后的[进程复查](../../../artifacts/engine-0.2.1/g09/windows-search-paused-20261006T113142/post-run-processes.json)未发现 Engine headless 浏览器、采样 Node 或 UnityPy 安装残留；该 5 秒窗口总 CPU 为 12.756%，恢复后的索引进程合计约 9.531%。这属于失败后的观测，不用于反推采样时 20.949% 的来源。下一次性能运行前需要定位突增时段的 CPU 来源或使用稳定的专用测试环境；继续重复整轮采样尚无依据。

## 后续完成条件

2026-10-06 晚的[连续进程归因与完整复测](performance-host-diagnosis.md)已定位到界面刷新干扰与 Search 在采样中重新启动。用户自行退出 VS Code/Epic 后，增加采样时间提示，并临时阻止 Search 重启；结束时恢复原自动延迟启动及运行状态。最新完整人口已取得 12/12 次捕获，全部 24 次主机检查通过。完整判定仍因 A0 八灯 CPU 轮次不稳定而失败，独立重算一致；同配方预热敏感性诊断保留为诊断，不修改正式 120 帧协议或放宽预算。

当前 Windows 支持路径的正确性已通过，旧 Intel 不再是其阻塞项。遗留安装进程已清理，完整 Forward 预检人口已取得；随后已完成 18 次同场景三轮预热校准，但其中 3 次受火绒/Codex 等后台活动干扰，1200/2400 帧间的稳态平台判据也未成立。下一项是在安静的独立采样环境复核共同预热规则，分离冷启动与稳态并重建稳定基线；当前不能直接改大预热参数宣告通过。另须补齐 F0–F8 的完整性能实现、非重叠 CPU 阶段、全资源与冷启动归因、至少三轮 A0/B4 及预登记消融、稳定性与至少一个真实收益；这些尚未实现/验收的工作并非由本次主机负载检查覆盖。G05/G07 按最终候选重新验收，clean release 证据与 dirty 开发证据分开。

新 Windows 主机为 GTX 1070 Ti/Pascal；既有硬件及驱动记录见 [Windows 复现审计](windows-reproduction.md)。该文及 [旧检查摘要](windows-checks.json) 保留修订前的诊断身份，其 32＋32 次结果不提升为新合同证据。
