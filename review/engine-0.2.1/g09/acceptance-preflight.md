# G09 完整验收推进 — 2026-10-11

用户要求继续 G09 完整验收。G09 保持 active；本检查点补齐完整场景登记与正确性预检入口，不授予性能、G05 或 G07 发布资格。独立长批量完成诊断尚无新完成结果，原 5% 回归预算不变。

## 场景与入口

权威登记为 [验收场景表](../../../scripts/webgpu-gate/framegraph-acceptance-cases.mjs)。共 60 个场景；Windows Chrome/Edge 共 224 次捕获。新旧版本都执行生产场景；新图内部结构与既有生命周期专项使用 B4 和各自独立 oracle，不伪造 A0 不具备的内部接口。

| 组 | 本次预检范围 | 性能边界 |
| --- | --- | --- |
| F0 | 冻结 billiards 内容、720p、1/8 灯，显式关闭后处理，零 Deferred 创建 | 与此前继承后处理的 Forward 诊断分别登记；尚未采集正式计时 |
| F1 | 128/256 灯 × 稀疏/高重叠 × 静态/动态 × reference/tiled，720p | 完整灯数和全图 HDR/LDR 配对；尚无三轮计时 |
| F2 | 1080p、128 灯、全分辨率高质量 GTAO、reference/tiled | 复用既有 cost fixture；短计时只作夹具检查 |
| F3 | 720p、128 灯、透明 PBR、TAA、GaussianBlur、Outline | 固定 32 帧图像准备；不充当共同稳态预热 |
| F4 | 单视图、四视图、混合尺寸/局部 viewport/不同可见集合 | HDR 按 viewport 尺寸、显示图按完整目标尺寸核验 |
| F5 | 720p 主输出、640×360 外部 HDR RTT 或镜面，reference/tiled | 明确镜面主视图 Forward 回退；不重复归因原有镜面缓存收益 |
| F6 | 既有物理复用和缓存/附件操作原生消融正确性 | 观察者/导出根转换仍需专门验收；不等于完整 A/B1–B4 性能归因 |
| F7 | 既有材质/输出/辅助、多视图、312 次生命周期切换、设备专项 | pending/读回设备恢复证据仍需整合，真实恢复与注入分开 |
| F8 | 1k/10k × 单/四视图 × 四种 LOD/视锥模式；512/1024 灯压力 | 实例使用独立 CPU ID、姿态/法线和像素 oracle；不将不同 LOD 几何作同画质加速比 |

只读计划：`npm run verify:framegraph:acceptance:plan`。初步场景验证：`npm run verify:framegraph:acceptance:smoke`。完整正确性预检：`npm run verify:framegraph:acceptance:correctness`。原始报告复核：`node scripts/verify-framegraph-acceptance.mjs --audit=<report.json>`。

入口复用固定 A0 和当前 B4 构建，拒绝过期输入；不改写旧构建或既有原始数据。每次执行建立新目录，绑定 revision/dirty、源码/构建、HTTP 实际字节、夹具、浏览器/后端和原始文件 SHA-256。两个直接使用 Engine dist 的既有辅助夹具单独绑定实际包字节，不冒充私有 A0/B4 测量或 clean source-to-dist 发布资格。独立复核重新读取每份原始文件并重算全部像素差；缺项、失败、换序、换浏览器/设备或输入改变均拒绝通过。

## 验证过程

12 项定向策略测试通过。最初 20 次双浏览器 smoke 完整通过，随后增加原始 HTTP 来源与实际灯数核验，开始完整 224 次预检。中间的资源路径、重复模块构造器身份、计数初始化、局部 viewport 图像维度问题均属于新夹具接线，失败尝试保留；未修改生产 runtime 或旧采样工具。

首个完整尝试由本轮主动中断，以补齐两项旧辅助夹具的 dist 字节核验。中断只针对该验收器启动的无界面浏览器；该批次保留失败，不把已完成样本拼入下一批。最终执行结果以后续本页记录及机器证据为准。

## 完整预检结果

[完整原始报告](../../../artifacts/engine-0.2.1/g09/acceptance-full-2026-10-11T02-54-48.139Z/report.json)于北京时间 2026-10-11 11:20 完成，**224/224 次通过**。Chrome、Edge 各 112 次；独立重读原始文件并核验 SHA-256、HTTP served bytes、浏览器/设备、场景和完整人口后，72 组 A0/B4 配对、100 个视图的 HDR/LDR 最大差异均为 0。最少非黑显示像素占比约 58.58%，没有用全黑等于全黑取得通过。

生产 runtime 指纹仍为 `5a8ef7d702493b4f374c0a94ffc55ba9bec95e22208084c21d82b974cfd58812`；本轮没有修改生产渲染代码。采样使用 dirty 开发树，所有短 CPU/GPU 数据仍为诊断，不能纳入正式性能人口。报告明确保留 `performanceQualified=false`、`g09Complete=false`。

F0 只断言显示输出，兼容传输字段中的副本不额外证明 HDR；其余登记场景读取逐视图线性输出。最终审查将非黑像素下限对齐既有 room oracle 的 10%（初版为 1%）；通过独立重算原始像素验证更严格下限，不重采或删改样本。

## 补充专项与工程检查

[独立严格复核](../../../artifacts/engine-0.2.1/g09/acceptance-independent-audit-20261011.json)通过。以下三项在完整捕获结束后串行执行，Chrome/Edge 均通过，详见[专项执行记录](../../../artifacts/engine-0.2.1/g09/acceptance-native-extras-20261011T032114032Z/checks.json)：

- [生产裁剪](../../../artifacts/engine-0.2.1/g09/culling-2026-10-11T03-21-17.920Z/native.json)：像素一致与实际 pass 减少。
- [读回设备丢失](../../../artifacts/engine-0.2.1/g09/readback-device-loss-2026-10-11T03-21-30.865Z/report.json)：reserved、mapping、disposed-reservation 三种状态均终止且 pending 清零；这是显式销毁原生设备触发的生命周期验证，不是发生系统 GPU 重置后的恢复证明。
- [按需诊断示例](../../../artifacts/engine-0.2.1/g09/inspector-2026-10-11T03-21-37.777Z/native.json)：Forward/reference/tiled 未武装及捕获前后画面一致，物理映射、裁剪、冻结 JSON/PNG 导出和待捕获销毁通过。UI 导出不等同于生产资源消费者增删的完整转换验收。

初次全仓测试在 Shader include 的符号链接夹具遇到 Windows 沙箱 `EPERM`；原失败日志保留。以正常系统权限重跑全仓测试 **1,446 项通过**（135 Shader、775 Engine、107 animation-spec、422 extensions、7 catalog），未跳过或修改测试。FrameGraph 策略 86 项、性能预算策略 244 项、benchmark 策略 31 项、typecheck、root build（98 fresh examples）、docs、API、模块/责任/prepare/Shader/发布范围均通过。

重新构建后，152 个已绑定包 JS/WASM 文件中仅 `engine/dist/index.js` 字节变化；固定 A0/B4 制品、其余包文件和 inspector 输入未变。对使用该入口的两个辅助夹具执行[双浏览器四次补充捕获](../../../artifacts/engine-0.2.1/g09/acceptance-built-auxiliary-2026-10-11T03-38-55.117Z/report.json)，并[重跑生产裁剪](../../../artifacts/engine-0.2.1/g09/culling-2026-10-11T03-40-11.814Z/native.json)，全部通过，原 224 次报告不覆盖、不拼接。补充捕获首次报告的源报告 hash 字段采用了 JSON 规范化字节；改为源文件原始字节 hash 后重新完整执行四次，旧记录保留。

`release:no-rive --artifacts` 首次发现三个已退出清单的旧示例残留 9 个 2026-09-05 生成文件。它们已按原字节[迁入本次证据备份](../../../artifacts/engine-0.2.1/g09/acceptance-governance-20261011T033401558Z/stale-example-builds/moves.json)，未删除；重新核验 3,471 个文件通过。

**本地打包消费未通过，仍是发布卡点。** 全新安装按现有版本范围解析到了 loaders.gl 4.5.4，其中依赖精确的 `@loaders.gl/worker-utils@4.5.4`；安装报 `ETARGET`，独立强制在线版本查询也报 `E404`。仓库现有 lock/node_modules 使用 4.4.4，所以源码构建和测试通过不能证明新消费者能安装。参见[安装失败日志](../../../artifacts/engine-0.2.1/g09/acceptance-governance-20261011T033401558Z/public-packages.log)与[在线查询日志](../../../artifacts/engine-0.2.1/g09/acceptance-governance-20261011T033401558Z/worker-utils-registry-query.log)。未修改依赖范围、lock、包预算；旧 `artifacts/release/public-packages.json` 是历史记录，不能冒充本次报告。

本次结果、文件 SHA-256 和剩余资格见[机器复核记录](acceptance-preflight-checks.json)。

外部长诊断入口的既有 319 项文件绑定重新核对，全部未改变。本轮未建立新基线，尚无 `gpu-batch-long-closed-*` 完整长诊断结果；下一步仍须按[外部入口说明](batch-completion-launch-interruption.md)从资源管理器独立启动。

## 完整 G09 仍需完成

1. 外部独立长批量完成诊断、共同采样机制确认与稳态冻结；诊断本身不建立基线。
2. F0–F5、F8 的三轮 A0/B4 完整计时与原预算判定，独立冷启动及无重叠 CPU 阶段归因。
3. active/idle/pending/persistent 的完整资源高水位、逻辑/物理映射与带宽代理；不是单张 warm snapshot。
4. F0/F2/F3/F4 预登记的 A、B1、B2、B3、B4 消融、轮次区间与至少一项可归因的生产收益。
5. F6 观察者/导出根和 F7 pending/设备恢复证据整合，以及最终候选 G05/G07 的性能证据消费。
6. 修复全新打包消费者的依赖解析失败，再完成同一候选的包消费与发布链；不得用当前 node_modules 已安装成功代替。

本次预检即使通过，报告也必须保持 `performanceQualified=false`、`g09Complete=false`。不把缺失内容变成绿色，也不替代 [完整 G09 计划](../../../../milestones/milestones/m18-engine-0.2.1/goals/g09-framegraph-optimization.md)。
