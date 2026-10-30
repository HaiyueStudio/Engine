# Engine 0.2.1：问题、方法、结论

本页只保留实现结论。候选输入以[机读清单](release-candidate.json)及其指向的 qualification/candidate-lock 为准；发布以实际注册表、签名标签、Release 与部署验证为准，版本号、旧状态文件或历史通过记录都不单独证明已发布。

| 问题 | 方法 | 结论与边界 |
| --- | --- | --- |
| Forward 难以完整处理多灯，视图/透明/扩展材质容易丢覆盖 | 全灯 Deferred 参考、Tiled 路径及同帧完整灯表回退；保留 source/view owner 和线性 HDR | 实现与原正确性验证完成；不以漏灯换性能。像素 oracle、灯表容量和不支持路径仍是硬要求 |
| AO 调制语义和在途资源占用错误 | 只调制 ambient/IBL，采用 R16F，按真实物理纹理与缓冲合并记账；GPU 完成后回收 | 旧 1080p GTAO 分配约63.77MiB，64MiB合同未放宽；调试读回与正式性能分开，内存回退成本单独报告 |
| 多视图反复分配绑定组/冻结对象，FrameGraph 临时目标与计划重复 | 共享稳定数据，活跃根裁剪、有界结构缓存、按生存期复用目标 | 原像素/资源与结构收益验证见 [G09](g09/README.md)；不把局部减少等同于整体FPS提升 |
| 冷启动和微基准受到 GPU/驱动/机器状态影响 | 加载期保留真实准备成本，正常调度下分别验收首段交互/稳态；同版本配对调查 | 按 [ADR 0124](../../docs/for-ai/adr/0124-g09-production-performance-acceptance.md)验收G09生产流畅度；[ADR 0127](../../docs/for-ai/adr/0127-forward-cpu-investigation.md)仅将Forward CPU相对5%作为调查，GPU及其他预算保持。原失败不改写 |
| Toast 原定下一 minor，游戏需要在0.2.1使用 | 按用户具名决定纳入稳定 `./gui`，保持根30符号 | 范围见 [ADR 0128](../../docs/for-ai/adr/0128-toast-in-021-release.md)；旧不含Toast的报告不能自动授予新候选资格 |
| readback 在 owner 释放后读取诊断，误报缓存活动为零 | 释放前保存活动数据，释放后仍检查残留 | 修复对象为夹具；原120/1800帧及限定复核规则见 [ADR 0129](../../docs/for-ai/adr/0129-readback-repair-evidence-reuse.md)，原失败保留 |
| Windows PBR 字体/控件使整页截图与旧平台不同 | 使用用户批准的独立Windows全页参考，六种模式、全部像素与原容差保持 | 见 [ADR 0130](../../docs/for-ai/adr/0130-pbr-windows-reference-evidence-reuse.md)；不缩小截图范围或修改材质/阴影要求 |
| FrameGraph JSON/PNG 下载等待超时 | 对实际页面 browserContextId 配置下载目录，缺失身份或拒绝即失败 | 实际导出与像素断言保持，限定复核见 [ADR 0131](../../docs/for-ai/adr/0131-framegraph-download-context-evidence-reuse.md) |
| Edge 首次导航与辅助进程退出存在环境等待 | 独立内存上下文；按配置/可执行文件/创建时间确认自有进程，退出信号与目录释放均需成立 | 等待只在采样外；导航时限、样本和性能预算不变，不终止无关应用，不用失败分项拼接资格 |

## 现行依据

- 原机器预算与基线：[配置](../../config/lighting-performance-021.json)、[冻结基线](g01-baseline-summary.json)；不随整理改动。
- 原生硬件范围与连续采样：[ADR 0117](../../docs/for-ai/adr/0117-native-021-hardware-scope.md)、[ADR 0125](../../docs/for-ai/adr/0125-g05-continuous-sampling.md)。旧Intel仍是扩展兼容调查。
- 证据复用：[ADR 0126](../../docs/for-ai/adr/0126-g05-stability-and-evidence-reuse.md)及后续具名例外；源码/配置/采样器/构建不满足条件不得复用。
- 来源与权限：[上游参考](upstream-reference.json)、[设备记录](device-plan.json)、[消费版本](consumer-versions.json)、[Deferred入口评审](g06-example-api-review.md)。

逐次候选、旧耗时/轮次、失败重试和临时启动命令已移出活动叙述，原文见[归档清单](../archive/engine-review-process-20261020.json)。原始采样、七组当前资格、发布制品和0.2.2工作不在本轮清理范围。当前门禁仍为完整独立包/API/Shader、画质、资源、正式性能和无发布演练；文档整理不授予资格。
