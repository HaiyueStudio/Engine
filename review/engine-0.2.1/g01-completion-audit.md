# G01 完成审计（设备条件阻塞）

截至本次工作进度，G01 为 blocked，未完成。这里列出原 Goal 各项要求的证据与缺口，不用已完成部分重新定义完成条件。

| 原要求 | 当前证据 | 状态 |
| --- | --- | --- |
| 复核来源并分类 | README 的 8 项 source census；Engine revision 未变 | 已复核 |
| 冻结材质、ABI、profile、owner、fallback、阴影/MSAA | ADR 0109 candidate；机器配置案例 A–G | 待最终一致性审查和冻结 |
| 两类设备与采集 owner | device-plan.json；adapters.json 的实际 native 适配器 | 已实测可用 |
| G-buffer 格式/精度配对 | gbuffer-probe.json，两类 device，3×rgba16float + depth32float | 已通过，不是带宽性能证明 |
| Forward + 已有 GPU 实例基线 | 其他任务自然结束后已重采 30 项；完整性通过，仍有 9/10 个组合波动超标；随后系统报告 CPU 限速 33/26 | 未满足稳定性；等待系统限速恢复后复核 |
| CPU/GPU 绝对预算基于实测冻结 | lighting-performance-021.json 的设备预算目前 null | 未完成，G02 不可启动 |
| 案例、seed、精度、内存、包体/Shader 评审方式 | 配置与 ADR 的固定房间/相机/灯光定义 | 已定义，待最终核对 |
| 上游 commit / license | upstream-reference.json，官方固定 commit 与 SHA-256，BSD-3-Clause | 已完成 |
| 消费方版本与独立发布线 | consumer-versions.json；协调仓 producerCandidates.Engine | 已登记，未改变消费仓依赖 |
| 采样/统计策略测试 | 新 12 项测试（含稳定性/冻结/主机限速负向断言）、26 项旧灯光测试通过 | 已通过 |
| 文档、API、性能策略与协调仓检查 | docs:check、api:check、协调仓 check 通过；performance-budget:test 获准 loopback 后完整 122/122 | 已通过；首次 EPERM 日志保留 |

## 最终冻结前的设计复核

- ambient 合同已改为每视图确定有效源后聚合，view header 32 字节；ADR、机器配置、内存公式和测试一致。现有 RenderView/Light 没有 per-light layer-mask API，本版保持现有 World/disabled/hierarchy 语义。
- 独立 artifact 校验已覆盖 30 个文件、每项 300 CPU/300 GPU 样本、3 个 cohort、真实适配器、HTTP served file hashes、场景来源与零验证错误。G01 未提交诊断数据不升级为 clean-release evidence。
- 跨轮稳定性要求为 P95 相对极差 ≤ 20%、CV ≤ 10%，必须全部满足。当前 9/10 个设备/场景组合未通过；`--require-frozen` 正确拒绝当前状态。所有轮次与慢样本保留。
- 已按用户选择等其他任务自然结束后重采样，没有终止原生渲染或编译。前一轮数据保留在 `attempt-1-contended/`；第二轮完整性通过但稳定性仍未通过。不能直接归因于已经结束的任务，不能提高绝对预算、降低样本数或挑选最快轮次。
- 绝对 CPU/GPU 预算仍为 null；稳定采样、预算依据与合同最终冻结完成前，G02 不可启动。
- 当前可验证的环境前置条件未满足：`pmset -g therm` 的 CPU speed limit 低于 100。新的 `--host-check` 已实际拒绝采样，旧报告仍保留。无法以修改引擎或放宽验收解决系统限速；等待设备状态恢复后再继续预算冻结。

## 阻塞审计与恢复条件

连续三轮 Goal 工作均未能取得可冻结的稳定基线：第一轮等待其他任务结束后重采仍有 9/10 个组合波动；第二轮查明当前系统限速并补齐前后检查；第三轮重新执行 `--host-check`，2026-09-25 12:45:54（UTC+8）仍报告 CPU speed limit 40，退出 1。之前两轮有实质进展，但相同的环境稳定性前置条件一直未满足。

当前没有正在执行的基线任务需要等待，继续重复采样不能绕过该条件。恢复需要外部设备状态变化：系统 speed/scheduler limit 均恢复 100，再运行新的完整三轮、验证稳定性、依据实测制定绝对预算并完成合同一致性审查。恢复主机状态本身不等于 G01 完成；不得仅因前置检查转绿就跳过其余验收。
