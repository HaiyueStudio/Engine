# Engine 0.2.1 G01：合同与基线验收

日期：2026-09-25。状态：G01 complete，预算与合同已冻结，必需门禁已通过；G02 ready，尚未启动。Deferred 生产实现和发布资格尚未完成。

## 阅读顺序

1. [ADR 0109](../../docs/for-ai/adr/0109-deferred-lighting-021-contract.md)：ABI、材质、pass 图、资源与回退合同。
2. [机器合同](../../config/lighting-performance-021.json)：案例、设备、精度、内存和逐场景绝对预算。
3. [预算冻结依据](./g01-budget-freeze.md)：用户确认的帧率目标与两项具名绝对上限。
4. [基线摘要](./g01-baseline-summary.json)：三轮结果、输入/政策/原始文件哈希。
5. [完成审计](./g01-completion-audit.md)、[上游固定参考](./upstream-reference.json)、[消费方版本](./consumer-versions.json)。

## G02 完成（2026-09-26）

G02 已完成，G03 ready、尚未启动。[完成审计](g02-completion-audit.md)与[最终检查证据](g02-completion-validation.json)记录当前结果。

收尾资料：[资源复用修复](g02-resource-reuse.md)、[生成物压缩](g02-bundle-optimization.md)、[最终原生验证](g02-final-native-validation.json)、[G03 交接](g03-handoff.md)。

本页保留 G01 冻结时的状态。后续工作见 [G02 进展](./g02-progress.md)、[四视图调查](./g02-four-view-investigation.md) 和 [Shader/包预算评审](./g02-budget-review.md)（[测量证据](./g02-budget-evidence.json)，预算已应用，原始证据保留提案状态）。

全量示例构建与 Lab 跨后端像素差异的后续修复见 [构建/Lab 评审](./g02-build-lab-fixes.md)。

## 冻结结果与证据范围

- 单视图 720p、128/256 灯目标：独显 60 FPS、集显 30 FPS。CPU/GPU P95 分别为 4/12 ms 与 8/24 ms，完整帧另受 1000/60 与 1000/30 ms 上限约束。1080p、四视图逐项预算见配置；512/1024 灯保留压力诊断定位。这些是 G05 的验收目标，不是现有 Deferred 性能结果。
- 本机两个实际 native 适配器为 AMD `rdna-1`（Radeon Pro 5300M）和 Intel `gen-9`（UHD 630），均支持 timestamp-query、非软件适配器。它们是同一主机的独显/集显两个类别，不是两台机器或移动端资格。
- 完整 30 项采样，每项预热 120 帧、保留 300 CPU 与 300 GPU 样本，三轮交错顺序；每设备/场景各 900 个样本全部参与统计。每项前固定空闲至少 30 秒，前后共 60 次系统 speed/scheduler limit 均为 100。实际加载的 HTTP 文件、场景、设备、工作量、输入指纹与原始文件哈希已独立复核。
- 10 个组合中 8 个同时满足 CPU/GPU 相对极差 ≤20%、CV ≤10%。用户明确批准独显 1k 实例 GPU ≤0.10 ms、10k 实例 CPU record ≤0.22 ms 两项绝对上限；它们仍标注 `stable=false`，只按 `approved-absolute-ceiling` 纳入。其他案例和既有回归阈值不变。
- CPU 指标不混用：灯光基线为 runtime frame；现有实例基线为 cpuRecord，cpuSubmit、frameWall、queueWait 单独保留。后续 Deferred 的 CPU 预算必须测 prepare+record+submit，不能用 cpuRecord 单项代替。
- 固定原始证据在 `artifacts/engine-0.2.1/g01/frozen-baseline/`；[独立检查](../../artifacts/engine-0.2.1/g01/completion-check.json) 返回 integrity passed / freeze ready。该诊断基线仅用于 G01 合同校准，不升级为 clean-release 或完整 GPU 实例性能资格。
- [G-buffer 探测](../../artifacts/engine-0.2.1/g01/gbuffer-probe.json) 在两个实际 device 上通过 3×rgba16float + depth32float 的渲染/读回，normal 角误差约 0.0076°，零 validation error。它证明格式与量化可用；ADR 的读写 payload 是理论估算，不是实测 DRAM 带宽或驱动显存。

## 源码复核分类

生产源码观察点为 `365552908414ffa193c63a62aaf682f4ddb23b94`；采样基于 `61d40f7bf75e05ec948754d85fdbf70512a21ca8`，后者只提交 G01 规划和工具，生产 runtime 未变。捕获后只修改政策、统计验证器与文档，实际 served runtime/fixture 字节复核一致。采样时政策与最终冻结政策分别保留，不冒充相同文件。

| 项目 | 分类 | 依据与处理 |
| --- | --- | --- |
| 8 灯 Forward、3 方向阴影 | still-current | SceneLightData/Selection/ViewLightUniformBuffer；Deferred 输入必须来自未截断源集 |
| 辅助 MRT、frame graph、target pool | still-current | Render3DFramePlan/RenderGraph/TransientRenderTargetPool；扩展已有 owner |
| GPU timestamp 与异步 readback | still-current | 复用现有 profiler；正常帧不读回全部实例 |
| GPU instance / LOD / 外部 visible ID | still-current | ADR 0108 和既有专项；本轮仅静态外部矩阵 + LOD/indirect，动态模拟、画质收益和四视图完整资格仍属 G05 |
| 0.2.0 AO、Shader/示例预算和发布问题 | already-fixed | `review/release-0.2.0-global-check.md`；不重新立为未修 bug |
| Deferred/storage lights/Tiled/透明 PBR 全灯表 | new-work | ADR 0109；G02–G07 实现和验收 |
| 字体解析器同步传递成本 | deferred | AnimationTextRasterizer 的 opentype 静态导入仍在；先独立评估，不加入本 Goal 实现 |
| Spot/局部阴影/CSM/3D Clustered/Hi-Z/Rust | deferred | 独立准入；原 Forward+/CSM hold 不解除 |

## 上游、消费与发布边界

官方 webgpu-samples 固定 commit 为 `e040ec1a20dbbe01afed30c812e825b2639cfe5b`，默认 128、最大 1024 灯；compute 更新位置，fragment 仍遍历所有灯。固定文件 SHA-256 与 BSD-3-Clause 原文地址见上游记录。本轮未复制生产代码或 dragon mesh；将来改编代码须保留许可、版权及免责，资产许可单独核查。

Engine 四库源码为 0.2.1；Editor/Games lockfile 中 Engine 仍为 0.1.0，AIStudio 使用本地 0.1.0 变体，Native 示例使用 vendor tarball 0.1.0。冻结前再次核对全部已记录 manifest/lockfile 哈希，均未改变。版本相同不等于字节或兼容性相同。

UI 没有 Engine 依赖。协调仓仅登记 Engine 独立 candidate line，保留 0.1 消费范围，不升级其他仓依赖，不执行其门禁。Games 的实际 UI 依赖与原协调政策存在差异，仅记录。没有发布、tag、push、公开 API 或包版本变更。

## 失败历史与复现

- 初次构建遇原 120 秒超时，原命令重试约 76.9 秒通过；冒烟阶段的缺少 dist、运行中输入变更、枚举顺序指纹误报均保留日志，后者已排序去重并测试。
- 第一次完整采样受其他任务争用，第二次在它们自然结束后仍有 9/10 个组合波动。数据分别保存在 `attempt-1-contended/`、`attempt-2-post-contention/`。
- 随后系统报告 CPU speed limit 33/26/40，新增前后主机检查。恢复 100 后的第三次连续采样在第 14 项变为 95，按规则退出，保存在 `attempt-3-host-limited/`。没有终止其他任务或关闭系统保护。
- 第四次采用统一 30 秒场景间空闲，完成全量且主机检查均通过；两项微小时延波动的处理方法经用户明确选择后冻结，未挑最快轮次、删样或混合不同尝试。
- 独立复核命令：`node scripts/lighting-g01-check.mjs --require-frozen`。新设备采样先运行 `node scripts/lighting-g01-capture.mjs --host-check`；G05/G07 仍需执行各自完整正确性、持续运行、性能和 clean-release 验收。

## 最终验证

G01 policy/host 16/16、既有 lighting 30/30、performance-budget:test 122/122、docs:check、api:check、冻结证据检查与协调仓 check 均通过。新代码仅限诊断/政策设施，生产 runtime 与已有构建对应源码一致；不以这些检查替代 G02–G07 新实现和正式发布检查。

## G03 当前进展（2026-09-26）

G03 已显式激活，状态为 active；上面的 G02 完成时状态保留为历史。分块灯光、同帧溢出回退和高重叠自动选择的实现与验证见 [G03 进展](g03-progress.md)。G04–G07 未激活。

## G03 完成（2026-09-27）

G03 已完成，G04 为 ready、尚未激活；上面的阶段状态保留为历史。[完成审计](g03-completion-audit.md)、[最终性能报告](g03-final-performance-review.md)、[八场景证据](g03-final-room-matrix.json)及[G04 交接](g04-handoff.md)记录当前结果。停止竞争游戏后，重新完整采集 24 项并通过全部相对预算与稳定性检查；未拼接样本或放宽阈值。高重叠绝对帧率目标继续由 G05/G07 完成，不宣称发布资格。

## G04 当前进展（2026-09-27）

G04 正在实施，尚未完成。透明完整灯表路径的实现、双 GPU 正确性证据与未完成范围见 [G04 进度](g04-progress.md)。用户批准后的 Shader 成本预算、构建期 include 与 Artifact 去重见 [实施报告](g04-budget-import-application.md)；[原提案](g04-budget-import-review.md)保留当时测量。未来不透明扩展代理表面的预算仍需按实际实现核定。

## G04 安装修复与兼容性审计（2026-09-27）

[Editor 安装修复](g04-editor-install-repair.md)已完成，消费版本策略不变。G04 新增了不透明扩展 PBR 的完整灯表通路，并完成双 GPU 材质/效果/输出/实例回退/设备/312 次切换及 A/B 原生回归；最终状态见[兼容性审计](g04-compatibility-audit.md)。用户选择的[光照阶段 AO](g04-ao-contract-review.md)已完成；双 GPU 贡献隔离、1,367 项测试、95 个示例构建及 Stage14 全部通过。**G04 complete；[G05](g05-handoff.md) ready，尚未启动。**

## G05 activation — 2026-09-28

G05 已由用户激活，当前为 **active**；上一节的 ready 是历史状态。[进度与完整验收清单](g05-progress.md)记录分离 CPU/GPU 采样、逐视图像素检查、三轮房间矩阵和剩余性能资格。当前短测只属于诊断，不能替代两类 GPU 的完整性能验收。

## G05 实例资源与包体积检查（2026-09-28）

[实例缓存与包消费者审计](g05-instance-cache-review.md)记录四视图绑定组从每帧 12 个降至 0、双 GPU 32 项诊断和 37 个公开类型入口的真实安装验证。完整性能采样与其余 E/F/G 验收仍在进行，G05 保持 active。

## G05 AO 内存修复与对象分配归因（2026-09-28）

[当前检查点](g05-r16-checkpoint.md)记录 R16F AO、共享在途资源预算、双 GPU 像素/生命周期回归，以及 2,400 帧 CPU 对象分配采样。1080p AO 的 Deferred 内存已降到 64 MiB 预算内；全灯回退成本与完整 E/F/G 性能资格仍未完成。全仓 1,376 项测试、95 个示例目标和包消费者检查通过，不等于 G05 或发布验收完成。

## G05 静态灯快照复用（2026-09-28）

[实现与验证报告](g05-light-cache-review.md)记录静态场景双 GPU 采样分配量约 31% 的下降，及旧快照、稳定灯 ID、阴影槽和完整灯表的兼容性回归。全仓 1,380 项测试和 95 个构建目标通过。对象分配改善不代表帧率资格；GPU 成本和完整性能矩阵仍待完成。

## G05 GPU 耗时与全量性能门禁（2026-09-28）

[最新审计](g05-gpu-performance-audit.md)及[机器证据索引](g05-gpu-performance-audit.json)记录明确的 **failed-and-incomplete** 结果：Intel 高重叠在采样前后 CPU limit 均为 100 时仍为 62.70 ms（预算 24 ms）；Intel 完整 GTAO 长负载结束时出现 75/46 限速。Forward、F、E/G 全量入口已执行，但均被首例主机预检拦截，不能声称完成 264 次矩阵。三项 GPU 优化试验未证明所需收益，已撤回并恢复原运行时；185 项性能策略测试通过。G05 保持 active，未完成性能资格，未进入 G06/G07。

## G05 evening resumption — 2026-09-28

See [resumption audit](g05-resume-audit.md) and [hash-bound evidence](g05-resume-audit.json). Four current-runtime AMD/Intel pending/AO resource captures and the real package/29-consumer qualification pass. A timer early-wakeup defect was fixed without weakening the 120-second gate; 190 policy tests pass. The fresh full Forward/F/E-G attempt subsequently failed real host preflight (86/77/88), so full timing/stability remains incomplete. All processes are terminal; G05 is not complete.

## G05 完整复测（2026-09-29）

[完整性能审计](g05-full-performance-2026-09-29.md)与[机器证据索引](g05-full-performance-2026-09-29.json)已完成。Forward、F、E/G 和高重叠/GTAO 专项人口均完整，主机前后检查全部通过；预算及跨轮稳定性仍失败。G05 保持 active，G06/G07 保持 draft，未发布。上述历史阶段状态保留。

## G06 多灯示例 — 2026-09-29

[交互与集成验收](g06-example-audit.md)通过：96 个 fresh 示例目标、25 项 native 浏览器检查、API/包消费/生命周期验收完成。G06 complete；G05 仍未取得性能资格，G07 仍 draft。跨引擎及设备分档另立 M18 G08 draft。
