# Engine 0.2.1：验收结论

G01–G04、G06 的实现阶段已完成；0.2.1 现包含 GUI Toast。G05 与 [G09](g09/README.md) 的七组完整证据按 [ADR 0131](../../docs/for-ai/adr/0131-framegraph-download-context-evidence-reuse.md) 复核通过。`4bc3096` 于 2026-10-19 完成 G07 全局门禁，含 FrameGraph 真实下载、长读回、包消费和正式性能对照；后续无发布演练在启动检查因更新日志版本标题缺少空白分隔而停止。标题现按既有检查格式修正，补充 Toast 变更说明；文档候选须重新冻结、复核并完成最终执行链，尚未取得完整发布资格。原执行记录为 `artifacts/final-release-2026-10-19T00-09-18.438Z/execution.json`，原通过与失败均保留。阶段过程记录见 [归档](../archive/README.md)。版本号不是已发布证明。

**当前候选范围**见[机读清单](release-candidate.json)：用户明确要求将 `GuiToast`、`GuiToastOptions` 纳入 0.2.1，供依赖游戏发布使用；版本安排由 [ADR 0128](../../docs/for-ai/adr/0128-toast-in-021-release.md) 取代此前的推迟决定。使用 `Engine` 工作区包含 Toast 的干净提交，本地完整 revision 和运行时指纹写入清单指定的 `candidate-lock.json`。稳定 `./gui` 符号归属为 86，根入口仍为 30 个概念。工作区旁的 `start-engine-021-final-validation.cmd` 只接受冻结候选及按 ADR 0131 固定哈希的七份报告；旧工作区、旧报告和原失败全部保留。

下表实测数字来自旧采样提交 `e07d8fb` 和验收提交 `55feff1`，仅保留问题、解决方法和历史结果，不授予包含 Toast 的当前候选发布资格。

| 问题 | 结论 | 解决方法与剩余边界 |
| --- | --- | --- |
| FrameGraph JSON／PNG 检查等待超时 | 页面运行于独立上下文，原检查却只配置默认上下文的下载策略 | 为当前页面的实际 `browserContextId` 配置目录；缺失身份或协议拒绝继续失败。两浏览器 18 项与四份实际导出通过，原 60 秒上限及全部断言保持；限定复核范围见 ADR 0131 |
| PBR 示例整页截图的文字／控件跨环境差异 | 当前 Windows 为 NSimSun／Microsoft YaHei UI；六种模式的场景主体接近旧参考，新配置重复截图逐字节一致 | 用户批准单独 Windows 全页参考，旧参考保留；全部像素、模式、交互和原容差保持。只改四份具名页面检查文件，固定七组原始数据复核后仍须完整全局门禁和无发布演练 |
| readback/churn 缓存活动被误报为零 | 追踪器在 owner 释放时正确清除元数据；夹具此前在释放后取数 | 夹具逐 owner 在释放前保存真实缓存活动，仍在清理后检查资源残留。120／1800 帧及回归测试通过；不修改运行时、阈值或原失败报告。六组限定复核、224 项正确性重采及完整发布链见 ADR 0129 |
| 既有 Forward 不能完整处理百灯 | G02 全灯 Deferred 参考路径、G03 Tiled 路径已实现 | 独立几何/像素 oracle 检查完整覆盖；容量不足同帧遍历全灯，不以漏灯换耗时 |
| 多视图、透明与扩展材质兼容 | G04 兼容验收完成 | 保留 source/view owner、完整灯表、线性 HDR 与显式不支持回退；原生销毁恢复和模拟故障分列 |
| AO 语义与内存超预算 | 已改为光照阶段只调制 ambient/IBL；R16F 与联合在途资源核算将 1080p GTAO Deferred 分配降至约 63.77 MiB | 保留直接光、自发光和透射；64 MiB 预算未放宽。内存受限全灯回退的 GPU 成本仍需判断 |
| AO 在途资源诊断误报 | 旧断言按八个视图代次各计一张 AO 纹理，实际在同一编码器顺序复用为两张不同尺寸纹理，八份可见性缓冲仍各自保留 | 断言改为精确核对物理纹理与缓冲数量、大小和类型；四视图两代读回、拒绝时零分配、提交前存活、完成后归零及原资源上限全部保留。调试读回正确仅用于定位，正式结论以修正后原生捕获为准 |
| 正确性矩阵在 Edge 导航阶段超时 | 两次失败均发生在首个本地 HTTP 请求之前；空白页 NetLog 与 ABBA 对照确认，新配置的持久化 Cookie 初始化会造成约 5 秒等待，代理直连不能消除该等待 | 每次捕获仍启动全新浏览器和 GPU 设备，测试页改用 CDP 创建的独立内存上下文，避免磁盘 Cookie 初始化；A0/B4 与两浏览器一致，导航 30 秒上限、预热、样本和性能预算不变。失败上下文创建必须报错，不回落默认配置。Windows 收尾按唯一配置、可执行文件及创建时间核验并清理自有辅助进程；原失败和诊断均保留，最终完整矩阵仍须重新通过 |
| 实例绑定组与灯光对象分配 | 四视图每帧绑定组创建 12→0；静态快照与动态灯光未变化的冻结字段均可复用 | 600 组字节／快照对照通过；优化后候选 `e07d8fb` 独立动态 sparse-256 CPU P95 为 Chrome 3.640 ms、Edge 3.095 ms，均低于原 4 ms 上限。稳定 ID、阴影槽、完整灯表与原预算保持；机器状态也会影响耗时，不能把全部数值改善都归因于代码 |
| 测试浏览器辅助进程收尾中断 | 完整矩阵确认 Edge 会处于 `HasExited=true`、原生退出信号尚未触发的异步收尾阶段；原来按短固定轮数扫描过早报残留，不能仅凭退出属性或进程枚举判断完成。原失败均保留，具体待完成的驱动/I/O 类型未确认 | 先固定句柄并核验唯一配置与进程身份，再用单调时钟限定最多 60 秒的采样后退出等待；必须确认退出信号且目录已释放才通过，仍存活或退出未完成继续报错。记录进程角色、等待耗时和逐项状态。该等待不进入 CPU/GPU 样本，导航 30 秒、样本和性能预算不变；完整资格仍须独立验收 |
| 多灯与 Forward 性能资格 | `e07d8fb` 房间 60/60、实例 96/96 预算通过；Forward 原判定 6/8，Edge CPU 单灯／八灯 +8.05%／+20.35%，全部 GPU 通过 | 48 次对照中，16 对同版本有 12 对 CPU P95 差异超过 5%，最大 +40.8%。用户批准 [ADR 0127](../../docs/for-ai/adr/0127-forward-cpu-investigation.md)：仅 CPU 相对 5% 改为调查，GPU 5% 与其他预算保持。原失败和全部样本保留，不将诊断结果替换正式报告 |
| 交互式诊断缺少产品入口 | G06 多灯示例及最小 experimental facade 已完成 | 稳定 root 未扩大；原生交互、资源释放及独立包消费通过。API 范围见[评审](g06-example-api-review.md) |
| FrameGraph 集成与验收过度依赖微基准 | 实现已落地；用户批准以生产流畅度和可复现退化验收 | 5% 改为 G09 调查触发线，旧校准/基线非前置；真实生产证据、资源稳定、归因收益与 clean release 仍必需 |
| 本机生产路径是否流畅 | 当前 `e07d8fb` 36 次生产捕获通过：64,806 个稳态间隔，最差 P99 16.92 ms，启动交互与稳态均无超过 50 ms 的间隔；四项各 310 秒资源长跑及 224 项正确性通过 | [结果与范围](g09/README.md)：40 次完整消融也通过，四视图 MRT 物理分配估算降低 75%，像素一致。七类原始数据与重建字节已在 `55feff1` 独立复核；完整全局发布门禁和无发布演练仍须完成 |

## 当前合同与证据

- [G09 当前验收](../../config/framegraph-acceptance-021.json)及 [ADR 0124](../../docs/for-ai/adr/0124-g09-production-performance-acceptance.md)：新规则不将历史失败改为通过，不取消其他合同。
- [G01 原机器合同](../../config/lighting-performance-021.json)、[冻结基线](g01-baseline-summary.json)：历史统计和具名绝对上限例外保留原字节。
- [G05 连续采样协议](../../config/lighting-continuous-021.json)及 [ADR 0125](../../docs/for-ai/adr/0125-g05-continuous-sampling.md)：固定预热后连续采样，完整矩阵和预算保留；Windows 重新配对 G01 来源基线与候选，不复用 Mac 耗时。`lighting:continuous:run -- --suite=rooms|instances|forward --plan|--smoke|--full` 分别运行；入口测试通过尚不代表原生完整矩阵取得资格。
- [ADR 0126](../../docs/for-ai/adr/0126-g05-stability-and-evidence-reuse.md)：G05 跨轮稳定性作为调查项；仅文档/验收解释变化且全部测量输入与新构建产物哈希一致时允许复核旧证据，采样提交与验收提交分列。[ADR 0127](../../docs/for-ai/adr/0127-forward-cpu-investigation.md) 后续仅将 Forward CPU 5% 改为调查项，GPU 5% 及其余硬门禁保持。
- [硬件范围](../../docs/for-ai/adr/0117-native-021-hardware-scope.md)：一条完整原生路径；旧 Intel Gen9 为扩展兼容。
- [上游许可与固定参考](upstream-reference.json)、[设备记录](device-plan.json)、[消费版本](consumer-versions.json)：保留来源与身份，不冒充当前采样。
- [历史 ZIP 与逐文件校验清单](../archive/README.md)：可检索 G01–G09 原文件名，保留未采用方案和失败证据；大型原始捕获仍位于原 `artifacts/` 路径。

保留的历史证据绑定干净采样候选 `e07d8fb293bda190c92dd23d14b873370227074a`，位于独立工作区 `Engine-rc-021-20261014`。2026-10-15 的独立执行索引为 `artifacts/final-release-2026-10-15T02-12-46.694Z/execution.json`，原报告及原失败保持。资源报告为 `study-resources-2026-10-14T12-14-11.050Z`，正确性为 `acceptance-full-2026-10-15T02-16-54.724Z`；二者位于该候选的 `artifacts/engine-0.2.1/g09/`。复核既有全量样本不改变任何测量输入，续跑不重复已通过矩阵。旧 `f0c1286`、`b65d63b` 的通过或失败仅作历史证据，不能覆盖新运行时。此处提交号指采样来源；最终验收仍由机读哈希绑定。

| 矩阵 | 完整捕获 | 性能预算 | 跨轮稳定性失败 | 原始报告（`artifacts/engine-0.2.1/g05/` 下） |
| --- | --- | --- | --- | --- |
| 房间 | 156/156 | 60/60；另有 156/156 内存检查通过 | 26/156 | `continuous-rooms-2026-10-15T02-41-10.790Z/report.json` |
| 实例 | 96/96 | 96/96 | 57/192 | `continuous-instances-2026-10-15T03-29-15.825Z/report.json` |
| Forward | 24/24 | 原 5% 预算 6/8；Edge 两项 CPU 未过 | 3/16 | `continuous-forward-2026-10-15T03-44-40.242Z/report.json` |

Forward Edge 单灯 CPU P95 为 1.275 / 1.180 ms，八灯为 1.390 / 1.155 ms（候选／基线）；原判定保持失败。48 次固定诊断保留全部 14,400 CPU 与 14,400 GPU 样本，同版本旧基线单灯为 0.920→1.295 ms，已证明测量变化，但未证明新版全部差距都是噪声。CPU 分析可见缓存键序列化成本，仍不足以单独解释最差轮次；频率、驱动或 JIT 的具体归因尚未确认。按用户批准的 ADR 0127 单列调查结果，不扣除“噪声额度”或挑选更快诊断替换正式样本。

完整补采索引为 `artifacts/final-release-2026-10-15T05-48-55.730Z/execution.json`，生产与消融分别为 `g09/production-local-2026-10-15T05-50-16.224Z/report.json`、`g09/study-ablation-2026-10-15T06-16-58.972Z/report.json`，同版本对照为 `g05/forward-controls-2026-10-15T06-29-34.352Z/report.json`（均在该候选的 `artifacts/engine-0.2.1/` 下）。原执行的 `evidence-complete-release-blocked` 状态不改写；`55feff1` 已通过单独的七报告专项审计，记录为 `artifacts/engine-0.2.1/qualification-audit-2026-10-15T08-00-05.443Z/report.json`。

发布仍需在下载检查修复后的同一干净候选按 ADR 0131 严格复核固定七组，再完成包/API/Shader、完整全局门禁、正式性能比较和无发布演练。ADR 0126 的默认复用限制保持：运行时变化要求新采样，不能用其他旧报告或单项 GUI 测试补位。归档期间不并行执行正式性能采样。用户已批准独立 Windows 页面参考；当前未执行版本发布、tag、push 或性能基线晋升。

发布门禁通过 `release:021:evidence:check` 读取 `artifacts/engine-0.2.1/qualification.json` 中显式绑定的七份完整报告：F0–F8 正确性、生产流畅度、资源长跑、消融，以及 G05 房间／实例／Forward。v2 清单包含验收 revision 和各报告的采样 revision、相对路径、SHA-256；校验器重读原始捕获与截图，核对当前源码、配置、主机和干净提交，并重新构建候选夹具逐项比较可执行产物。短测、缺项、不符合 ADR 0126 的异版、预算或原始完整性失败不能补位；该检查仍不代替独立包、Shader、生命周期和其余发布门禁。用户说明见 [0.2.1 候选说明](../../docs/engine-guide/release-notes-0.2.1.md)。
