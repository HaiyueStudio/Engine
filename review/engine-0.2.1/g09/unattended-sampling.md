# G09 独立采样与同机基线重建

日期：2026-10-07。用户要求完成独立无人值守采样、确定 A0/B4 共同冷启动／稳态口径并重建同机基线，保留原 5% 回归预算。

最新结果：[优化后第二轮 v3](gpu-state-stability.md)于本地 17:52–19:14 完成。共同 CPU 预热仍为 6000 帧，CPU 回归 4.42%/2.56% 通过；八灯 A0 GPU 三轮稳定性失败，总体未通过。此前[首轮 v3](controlled-sampling-result.md)的稳定基线与 CPU 失败、以下历史入口修复均保留，不混用两轮人口。

当前结论：完全退出 Codex 后的 v2 校准已完成，12 项捕获和 24 次主机检查全部通过，但五个预登记候选均未形成共同稳态。独立重算确认该失败；未冻结稳态起点，未生成新基线。下文按历史顺序保留旧尝试，最新证据见“完全退出后的完整 v2 结果”。不再要求用户原样重跑。

## 已实现的流程

- [ADR 0118](../../../docs/for-ai/adr/0118-g09-cold-steady-sampling.md)和[版本化配置](../../../config/framegraph-sampling-021.json)固定两场景、三轮 AB/BA/AB、120 秒实测冷却与共同稳态边界选择规则。[ADR 0119](../../../docs/for-ai/adr/0119-g09-extended-calibration-horizon.md)在首轮完整校准失败后预登记扩展观察范围。
- [独立包装器](../../../scripts/run-framegraph-unattended.ps1)通过隐藏的独立进程执行，按秒写进程记录，不向交互界面持续输出。按用户授权临时停止并防止 Search 自启，在 `finally` 恢复原启动方式、延迟启动设置和运行状态。
- [采样入口](../../../scripts/verify-framegraph-sampling.mjs)先完成整幅像素对照，再校准；只有两版本／两场景全部具备共同稳定窗口，才冻结协议并以全新人口重建基线。[独立验证入口](../../../scripts/validate-framegraph-sampling.mjs)重新检查原始文件、生产者及运行时哈希，重算统计和冻结时序。
- 冷启动初始化、显式 pipeline 预编译、首 120 帧与稳态分开。v1 连续校准保留每项 12000 帧；v2 将观察范围扩展为 24000 帧。稳态仍保留共同预热后的全部 3000 CPU 样本及独立 120 帧 GPU 预热后的 300 GPU 样本。旧 G01/G05 120 帧协议和失败记录不覆盖。
- 原 CPU/GPU P95 5% 回归、spread≤20%、CV≤10%、主机 CPU≤15%／GPU≤10% 均保留。额外要求采样前连续三次 CPU≤5%，仅在没有产生计时样本时等待，最长十分钟；采样后失败不补拼人口。

## 工程验证

[检查日志目录](../../../artifacts/engine-0.2.1/g09/sampling-engineering-20261007/)保存：全仓 typecheck、test、build、98 个 fresh 示例、API 检查、文档检查、232 项性能策略、59 项 FrameGraph 策略及最后 17 项定向测试。首次沙箱内全仓测试因 Windows 禁止创建测试用符号链接而 EPERM；以主机权限重跑后通过，原失败日志保留。

## 入口验证与主机干扰

[独立入口验证](../../../artifacts/engine-0.2.1/g09/unattended-smoke-20261006T225150Z/measurement/report.json)完成两组整幅像素对照及 A0 单灯 12000 帧，所有 GPU 资源和 owner 残留为 0。后测 CPU 15.376% 超过原 15% 上限，按失败保留；[服务记录](../../../artifacts/engine-0.2.1/g09/unattended-smoke-20261006T225150Z/service-state.json)确认 Search 原状态已恢复。

同步逐进程记录中，Codex GPU 进程 PID 12636、网页渲染进程 PID 21804 与主界面 PID 14956 合计持续占用约 9–10% CPU，捕获收尾还有采样进程自身的短时开销。2026-10-07 07:04 的 Windows GPU 引擎计数器确认 PID 12636 的 3D 引擎为 19.212%，graphics_1 为 12.377%；这两个引擎数值不能直接相加当整卡占用。当前聊天的内置浏览器没有可关闭的标签页。没有停止安全软件、Codex 或其他聊天的进程。

[完整独立流程](../../../artifacts/engine-0.2.1/g09/unattended-full-20261006T225900Z/measurement/report.json)完成当前入口的两场景图像预检，但在首项计时前因主机持续繁忙超时退出：39 次就绪观测跨度 613.617 秒，CPU 7.547%–23.475%，GPU 17%–31%。每次 GPU 都超过原有 10% 上限，因此阻塞并非仅由新增 5% CPU 入场规则造成。正式校准捕获为 0；尚未冻结共同预热长度或生成新同机基线。用户已被请求最小化 Codex 并保持机器空闲，尚未取得操作确认，不将未回复当成已操作。

[独立恢复核验](../../../artifacts/engine-0.2.1/g09/unattended-full-20261006T225900Z/service-verification.json)确认 Search Running/Auto、Start=2、DelayedAutoStart=1，测试进程无残留，VS Code/Epic 仍未运行。首次残留查询误匹配了查询进程自己的命令文本；原记录保留，排除当前 verifier PID 后重新查询为零，没有为此结束任何其他进程。[检查索引](unattended-checks.json)绑定本轮生产者、原始记录与工程日志。

## 最小化后的完整 v1 校准

用户确认最小化 Codex 并保持空闲后，[新一轮独立采样](../../../artifacts/engine-0.2.1/g09/unattended-full-20261006T234337Z/measurement/report.json)完成 12/12 校准、两场景像素对照、24/24 主机前后检查，GPU 资源与 owner 残留均为零。[独立重算](../../../artifacts/engine-0.2.1/g09/unattended-full-20261006T234337Z/measurement/revalidation.json)验证 16 个捕获及全部绑定，确认校准失败，未生成基线。后台 CPU 前后测为 0.780%–6.087%；此前的 Codex 持续负载阻塞已解除。

| 预热候选 | 共同平台 | 主要失败证据 |
| --- | --- | --- |
| 1200 | 失败 | 单灯 A0 P95 漂移 −7.35%；八灯 B4 −9.21% |
| 3600 | 失败 | 单灯 A0 −10.77%；另有窗口三轮 spread 超限 |
| 6000 | 失败 | 单灯 B4 −16.55%、窗口 spread 23.53%；八灯 A0 −11.54% |

[按时间段的诊断](../../../artifacts/engine-0.2.1/g09/unattended-full-20261006T234337Z/calibration-diagnosis.json)显示主要变化落在 CPU record，尚不能确认 JIT、GC 或驱动根因。这一完整失败人口不能截尾作为新基线。Search [独立核验](../../../artifacts/engine-0.2.1/g09/unattended-full-20261006T234337Z/service-verification.json)确认完全恢复，测试进程无残留。

v2 在新采样前预登记 24000 帧观察范围，保留原三个候选并追加 12000、18000。所有候选以全新的三轮数据判定，窗口宽度、漂移、spread/CV 和 5% 回归预算不变；不依据 A0/B4 比值选择起点。

## v2 独立采样与剩余干扰

[v2 独立运行](../../../artifacts/engine-0.2.1/g09/unattended-v2-full-20261007T003320Z/measurement/report.json)于 UTC 00:33 启动，完成图像预检及 10 项 24000 帧捕获。前九项通过，第十项结束后 CPU 18.534% 超过原 15% 上限，GPU 为 0%；按预登记规则终止，未补采、未选择共同边界、未启动基线阶段。

[逐进程核验](../../../artifacts/engine-0.2.1/g09/unattended-v2-full-20261007T003320Z/interruption-verification.json)确认 14 个原始捕获、生产者和运行时哈希均完整；不能把这一部分样本视为完整校准。UTC 01:12:33.951 的按秒记录中，Codex 界面进程 `ChatGPT.exe` PID 14956 占用约 13.76% CPU，系统总 CPU 为 19.42%，与失败的主机观测时间重叠。它是此次超限的主要已观测贡献者；不能把全量系统 CPU 与逐进程百分比简单等同，也不能认为最小化意味着该进程停止工作。

[独立恢复检查](../../../artifacts/engine-0.2.1/g09/unattended-v2-full-20261007T003320Z/service-verification.json)确认 Search Running/Auto、Start=2、DelayedAutoStart=1；测试进程零残留，VS Code/Epic 未运行。没有结束 Codex、安全软件或其他应用。

v2 的工程检查全部通过：[日志](../../../artifacts/engine-0.2.1/g09/sampling-v2-engineering-20261007/)包括 18 项定向测试、233 项性能策略、60 项 FrameGraph 策略，以及全仓 typecheck/test/build、98 个 fresh 示例、API 与文档检查。

共同稳态起点和新同机基线仍未成立，5% 回归预算没有放宽。继续前需要用户完全退出 Codex，避免当前界面的瞬时 CPU 工作再次进入测量区间。

## 完全退出 Codex 后的独立入口

已准备可双击的 [启动文件](../../../artifacts/engine-0.2.1/g09/start-with-codex-closed.cmd)，调用[独立启动器](../../../artifacts/engine-0.2.1/g09/launch-with-codex-closed.ps1)。启动器经过语法与计划模式检查，随后由用户独立运行。它最多等待五分钟让用户退出 Codex，确认界面进程结束后才运行既有采样器及临时 Search 隔离。超时退出不修改服务；不会主动结束任何应用。

用户在普通 CMD 中发现原入口无法找到 `pwsh.exe`：本机 PowerShell 7 位于 Codex 的依赖目录，仅 Codex 进程环境包含该路径。现入口使用 Windows 自带 PowerShell 引导，自动定位已存在的 PowerShell 7、Node 和 Git，仅为当前启动器及子进程补充路径，不修改系统环境变量。已在仓库外、PATH 仅含 Windows 系统目录的条件下通过真实 CMD 执行 `-Plan`，并实际启动三个依赖验证版本；[检查记录](../../../artifacts/engine-0.2.1/g09/launcher-path-check.json)确认未创建采样目录、Search 状态未改变。CMD 也会保留失败退出码，启动失败时不会提示已生成结果。

随后一次[用户启动记录](../../../artifacts/engine-0.2.1/g09/unattended-closed-codex-20261007T022808Z/service-state.json)显示 Search 原本为 Stopped/Disabled，旧包装器错误要求它必须 Running，因此未启动采样便退出。`restored: true` 只说明服务与原状态一致，不能当成采样成功。

该前置条件已修复：Running/Stopped 均接受；原已 Disabled 时不重复修改启动方式，原已 Stopped 时不调用停止操作。需要暂时防止自启时仍先记录完整原配置，并在成功或失败后恢复原运行状态、启动方式及延迟启动字段（包括字段原本不存在的情况）。原本停止的服务不会被启动。独立启动器会明确提示采样未启动、采样／验证失败或通过，不再统一打印 `Completed`。

[实际服务检查](../../../artifacts/engine-0.2.1/g09/search-service-check-20261007T023533Z/independent-verification.json)通过：检查前、隔离时和检查后均 Stopped/Disabled、Start=4、DelayedAutoStart=1，未产生性能样本。新增 `ServiceCheck` 仅检查服务隔离与还原，不进入 Chrome 或测量流程。[回归测试](../../../scripts/webgpu-gate/framegraph-unattended-service.test.mjs)覆盖八种状态／错误场景并接入 FrameGraph 策略测试；历史捕获和门禁预算不变，后续新人口绑定更新后的包装器哈希。

整轮使用新的输出目录。采样结束后自动恢复 Search，完整人口会自动执行独立重算，并写入 `completion.json`、`service-verification.json`。若主机或校准失败，完整保留失败，不自动重试或延长协议。可先用启动器的 `-Plan` 查看计划而不改动服务。

## 完全退出后的完整 v2 结果

用户独立运行于 UTC 2026-10-07 02:58–03:44 完成（本地 10:58–11:44）。[原始报告](../../../artifacts/engine-0.2.1/g09/unattended-closed-codex-20261007T025839Z/measurement/report.json)包括两场景图像对照和 12/12 项校准，每项完整保留 24000 帧，共 288000 个 CPU 样本。全部 24 次主机前后检查通过，CPU 为 1.187%–8.046%，GPU 为 0%–1%。[独立重算](../../../artifacts/engine-0.2.1/g09/unattended-closed-codex-20261007T025839Z/measurement/revalidation.json)验证全部 16 个捕获、生产者、运行时和数据哈希，并再次得出 `calibration-failed`。

| 共同预热候选 | 主要失败证据（连续两窗口 CPU P95 漂移） |
| --- | --- |
| 1200 | 单灯 B4 +9.16%；八灯 A0 −8.15% |
| 3600 | 单灯 B4 −12.93%；八灯 B4 −11.03% |
| 6000 | 单灯 B4 −6.11%，首窗口三轮 spread 25.62%、CV 10.90% |
| 12000 | 单灯 A0 +15.93%，后窗口 spread 43.48%、CV 17.90% |
| 18000 | 单灯 A0 +28.57%、B4 −13.19%；八灯 A0 +5.22%；两个单灯分组另有窗口稳定性超限 |

最晚候选的单灯 A0 合并 P95 从 0.560 ms 升至 0.720 ms，P50 约为 0.465 ms 且基本不变。第一轮 A0 的八个连续 3000 帧区段 P95 为 0.870、0.665、0.650、0.590、0.565、0.825、0.555、0.755 ms，后段峰值重新出现，不能再解释为一直尚未预热完成。变化主要落在 CPU record；A0 自身也失败，不能据此判定 G09 引入了回归。

[分段与进程诊断](../../../artifacts/engine-0.2.1/g09/unattended-closed-codex-20261007T025839Z/calibration-diagnosis.json)由[离线分析器](../../../artifacts/engine-0.2.1/g09/analyze-closed-codex-calibration.mjs)生成，逐项核验原始捕获哈希，未删除或替换计时样本。整个按秒进程记录没有出现 Codex/ChatGPT。采样区间内观测到其他后台峰值，例如单灯 B4 第一轮的 AggregatorHost 约 12.49% 和第三轮的 HipsDaemon 约 16.76%。这些只是完整捕获区间的观测；现有数据没有逐帧 UTC 对齐，区间也包含浏览器启动、GPU 采样和收尾，不能将峰值直接归因到失败窗口，更不能把含基准自身的系统 CPU 当作原有前后主机门禁失败。

本次退出码 1 表示共同稳态选择失败，既非 `pwsh` 缺失，也非 Search 前置条件故障。`frozen-protocol.json` 和 `same-host-baseline.json` 均未生成，原 5% 回归预算保持。按 [ADR 0119](../../../docs/for-ai/adr/0119-g09-extended-calibration-horizon.md)，不自动延长范围或重复同一人口。[恢复核验](../../../artifacts/engine-0.2.1/g09/unattended-closed-codex-20261007T025839Z/service-verification.json)确认 Search 回到原来的 Stopped/Disabled、Start=4、DelayedAutoStart=1，测试进程无残留；没有结束安全软件或其他应用。

启动器现会直接打印报告原因、完成捕获数、各候选失败分组、独立重算状态及基线文件是否存在。新增 `-ReportDirectory` 只读展示已保存结果，进入该分支不会等待 Codex、发现依赖、修改服务或启动采样；其退出码 0 仅表示报告展示成功，不改变记录中的失败。原始运行的启动器快照和退出码保留。真实失败报告已分别用 Windows PowerShell 5.1 和 PowerShell 7 回放验证，计划模式也保持可用。

后续[CPU record 原因诊断](cpu-record-diagnosis.md)现累计七次长采样，含新增 Codex 退出后的 A0/B4 各 24000 帧：A0 最后窗口 record P95 从 0.360 ms 升至 0.625 ms，同时处理器性能指标从约 112 降至 68；独立算术探针也变慢并随之恢复，B4 本次后半段稳定。已收敛到 CPU 执行状态变化这一重要因素，具体触发机制及电源干预效果仍待验证。带分析器的捕获仅作诊断，不能混入基线；后续是固定三段的 A0 电源对照，而非原样重跑正式人口。不能据此放宽门禁或宣称性能验收已通过。

## v3 共同电源条件

三段独立 A0 电源对照已完成：控制段后半段 CPU P95 为 0.500、0.495、0.495、0.495 ms，恢复原方案后出现 0.755、0.510、1.020、0.555 ms。[ADR 0120](../../../docs/for-ai/adr/0120-g09-controlled-cpu-power.md)据此增加共同主机条件，历史 v2 配置另存，未重写上述失败结论。

当前入口运行 v3：临时复制原方案，仅提高交流最低处理器状态至 100%，所有 A0/B4 的图像预检、校准与全新基线共用同一副本；验证实际 AC 供电、最低／最高状态与方案身份，并跨校准／基线核验连续性。原 24 项完整流程、冷却、场景、候选和预算不变。失败仍阻断基线生成，电源与 Search 在退出时恢复，独立启动器再次检查还原。

v3 已通过[工程采集及独立检查](../../../artifacts/engine-0.2.1/g09/sampling-v3-smoke-20261007T061121Z/independent-verification.json)：两场景图像预检、一个完整 24000 帧捕获、实际电源条件检查与自动还原均通过。该运行只是在线 Smoke，尚未产生 v3 共同边界或新同机基线。连续频率数据只辅助归因，不用于丢弃慢帧或归一化正式耗时。

## 可重新执行的入口

以下维护者入口已接入 v3 共同电源条件。使用新的输出目录，从独立管理员 PowerShell 运行，完全退出 Codex 并保持电脑空闲；也可使用前述 CMD 启动器自动等待退出并在结束后独立核验：

```powershell
pwsh -NoProfile -File scripts/run-framegraph-unattended.ps1 -Mode Full -OutputDirectory D:\HaiyueStudio\Engine\artifacts\engine-0.2.1\g09\unattended-new-attempt
```

输出目录不得已存在。完整运行结束后，验证其 `measurement` 子目录：

```powershell
node scripts/validate-framegraph-sampling.mjs artifacts/engine-0.2.1/g09/unattended-new-attempt/measurement
```

`frozen-protocol.json` 只在完整校准通过后产生；`same-host-baseline.json` 只在新三轮 A0/B4 人口完成后产生。最新 v3 两项均已生成且 A0 稳定，但独立重算仍因 B4 CPU 超过预算判为失败：基线重建成功不等于候选验收通过。该主机仍是 dirty 开发证据，不能提升为 G05/G07 clean release 资格。
