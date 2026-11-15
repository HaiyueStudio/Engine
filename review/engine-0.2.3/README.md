# Engine 0.2.3 验收入口

G11 已完成。冻结候选 `4beb46f` 已通过设备验收、Windows 正式性能与 HYA 检查、Ubuntu CI、全局门禁和无发布演练。四个重建 tarball 的 SHA-256 与已验收制品一致。正式发布仍待确定从冻结候选还是从合入后的主干发布。 [G11 检查索引](g11-checks.json) · [候选资格证明](../../artifacts/engine-0.2.3/g11/final-qualification-4beb46f/g11-final-qualification.json)

合同：[ADR 0139](../../docs/for-ai/adr/0139-engine-023-gameplay-contracts.md) · [行为](contract.md) · [目标声明](api-contract.d.ts) · [机器合同](../../config/gameplay-023-contract.json)。本页汇总结论和剩余责任，逐次尝试与本次整理前原文见[归档清单](../archive/engine-review-entry-history-20261102.json)。原 checks JSON、原始捕获、合同和源码身份保留。

## 问题、方法与阶段结论

| 问题 | 方法与结论 | 检查索引 |
| --- | --- | --- |
| 发布终端／恢复不可靠 | 真实 TTY、原定位器、原子状态、owner 锁、附件回读及专用 CI 无发布验证 | [G02](g02-checks.json) |
| 场景加载缺少事务边界 | 原资产 owner、有界并发、准备后切换、取消与失败回滚 | [G03](g03-checks.json) |
| 角色／物理重复时钟 | 原 Box2D 形状扫掠、box／circle 子集及共享私有时钟，呈现不回写物理 | [G04](g04-checks.json) |
| 相机跟随需重复实现 | 借用原相机实现平滑、死区、边界、seeded 震屏及 reset | [G05](g05-checks.json) |
| 方向轴／重绑不一致 | 宿主与映射统一方向、不可变快照、冲突处理及保存恢复 | [G06](g06-checks.json) |
| 集合数据与行实例耦合 | 稳定 key、固定行高、有限窗口，回收前取消旧输入域与编辑 | [G07](g07-checks.json) |
| 地图编辑重建整图 | 图集／颜色模式、脏块、离屏延迟上传、有界驻留／工作／退役及恢复 | [G08](g08-checks.json) |
| 音频配置／定位重复开销 | 原 mixer 配置、淡出、2D 声像／衰减；owner 与活声音租约隔离释放 | [G09](g09-checks.json) |
| 复合 GUI 缺少共享合同 | Tabs／图标、Breadcrumb／Badge／Collapse 复用原布局、焦点、输入与资源 | [G10](g10-checks.json) |

G08–G10 的原生像素、独立消费者、包体、资源及整仓检查均按各自阶段索引解释，不授予整版资格。G08 的图集使用预乘 RGBA、nearest、首尾 texel 中心；0 为空、正值从 1 编号。原像素容差 1/255、GPU 5% 与各自预算保持；有限容量及原失败的依据保留在机器合同和检查索引。

## G11 组合正确性与修复

[组合示例](../../examples/gameplay-kit/index.html)复用场景、资产、物理、相机、输入、GUI 和音频 owner。安装包的加载／设置、32 角色、512×512 地图、集合窗口和 32 路音频已有正确性诊断；自动事件、静音音频及活跃桌面诊断不替代正式性能或设备资格。

跨场景 GuiSystem 通过同一 tracker 的注册租约保留至最后一条管线退出；SceneOutputPass 销毁解除私有管线引用并丢弃迟到／重复预热结果。损坏音频配置的输入部分提交由示例借原配置 API 回滚。原失败、资源交接和释放计数保留在 G11 索引。

动态 HUD 的布局／树校验、控件身份、重绘成本已进入 GUI P0／P1／P2 修复；当前检查索引记录脏节点清理、保留文字覆盖及按绘制片段更新，并维持同步公开通知与保守回退。原独立候选 `e752a15a` 的资格已标为 `superseded-by-gui-p2`，短入口有意阻止启动；不能再把旧准备完成解释为新运行时可直接正式采样。

## 干净候选、云端与设备准备

当前修复候选为 `307771a`。左／中／右试听改为等距及相同源音量，使用既有声像强度配置，保留距离衰减和远处静音。原浏览器左右总 RMS 为中心的 10%，iPhone 页面旧配置为 20%；新配置的原生离线 PCM 比值均为 1，声道隔离、循环源释放及远处静音通过。完整本地 Fast、四包／51 个消费者、128 次集合操作及 1,960 次导航通过，四个库包字节与 `1c84c10` 一致。[准备结果](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/device-preparation.json)和[原听音失败](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/audio-audition/physical-failure.json)保留。

[上一轮 307771a 设备包](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/engine-0.2.3-real-devices-307771a.tar.gz)约 18.5 MiB，5,322 个文件逐一回读校验。Windows 三个 current 入口及[Mac／iPhone 说明](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/README-current.md)已同步。Native 仅在已验证语料上应用具名试听配置与当前 vendor 包并重算来源；真实听音仍需设备记录。

最终候选 `4beb46f` 的 Engine Fast、Windows／Ubuntu 无发布控制器和完整 Ubuntu／SwiftShader CI 均通过。完整 CI 首轮的 Chrome DevTools 引导超时已保留，第二轮原样复跑通过。平面反射 4 组场景和 4 项像素检查通过，运动模糊 5 组用例在原 35 秒时限内通过，PBR 六个 Linux 整页参考均精确匹配。AO 按已批准的 600 秒调查处理，保留 14 个完整用例和下一用例的 24 次样本。 [Fast 复核](../../artifacts/engine-0.2.3/g11/final-qualification-4beb46f/ci-fast-acceptance.json) [完整 CI 复核](../../artifacts/engine-0.2.3/g11/final-qualification-4beb46f/ci-slow-acceptance.json)

历史 `7236b39` 的 Windows 正式性能、资源／画质、全局门禁及无发布演练已通过，`de464ec` 的云端 CI 已通过。原平面反射、运动模糊、PBR、AO、MSAA、输入与灯光归档问题及解决证据在 [G11 索引](g11-checks.json)保留，各自结论仍绑定原候选。

## 最终候选与发布来源

- Windows 最终候选的真实 IME、手柄和听音均已通过。手柄覆盖关卡启动、角色移动、导航、配置恢复、B 键起跳和落地，起点碰撞体挡住起跳的记录保留。听音的 13 个检查点覆盖声道、距离静音、淡出、配置恢复和切回前台。 [Windows IME](../../artifacts/engine-0.2.3/g11/final-apple-retest/windows-ime-4beb46f-final-acceptance.json) · [Windows 手柄](../../artifacts/engine-0.2.3/g11/final-apple-retest/windows-gamepad-4beb46f-final-acceptance.json) · [Windows 听音](../../artifacts/engine-0.2.3/g11/final-apple-retest/windows-hearing-4beb46f-final-acceptance.json)
- Mac 浏览器现场听音已通过。第一轮 12 个检查点覆盖声道、远处静音、淡出、音量重置、静音切换、暂停／恢复和切回前台后的播放。补测的三个关键检查点确认静音配置保存、取消静音、恢复静音均生效。新包 210 个清单文件逐项校验，原 204 个文件字节一致，音频、GPU 和测试进程残留为 0。 [Mac 最终听音复核](../../artifacts/engine-0.2.3/g11/final-apple-retest/returned-20261115T231035/mac-browser-hearing-final-acceptance.json)
- HYA 布局按原 27 组口径复测通过，HUD 10% 变更组三轮文本测量 P95 为 1.080、0.884、0.901 ms，均在 2 ms 上限内。23 项语料三轮通过。30 项 HYA 生产 GPU 捕获已独立复核，四组 GPU P95 均满足 5% 门槛，12 项候选生产帧节奏均通过。Windows 全局门禁第三轮通过，随后完成无发布演练及独立复核。前两轮的 npm 回执和 Rollup 退出失败保留。 [门禁及包哈希](../../artifacts/engine-0.2.3/g11/final-qualification-4beb46f/global-gate-continuation/global-gate-npm11-windows-cleanup-result.json) · [演练报告](../../artifacts/engine-0.2.3/g11/final-qualification-4beb46f/global-gate-continuation/passed-evidence/rehearsal-report.json)
- 当前主干 `a8b7ae6` 与冻结候选 `4beb46f` 分叉。重新比对发现 57 个交付树路径不同，其中 15 个为运行时源码。验收继续绑定冻结候选，正式发布需明确采用该源码或完成差异合入并复验受影响部分。 [当前差异](../../artifacts/engine-0.2.3/g11/final-qualification-4beb46f/release-source-alignment-audit.json) · [历史差异](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/main-source-binding.json)

iPhone 音频无声由运行时接线顺序导致，旧路径断在 voice-out → ui-in。Native `0e9db72` 先接好声音链，再接入总线，退役时断开总线并复用混音节点。该候选的 Mac 原生音频专项 14/14 通过。iPhone 真机通过左右／居中、距离静音、淡出、静音切换、音量及前后台恢复，退出后被追踪的音频与 GPU 资源归零。 [完整音频验收](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/iphone-remediation/github-retest/audio-bus-last/returned-20261110T124527/physical-audio-acceptance.json) [原断连证据](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/iphone-remediation/github-retest/audio-graph-paused/macos-graph-comparison.json)

Apple 最终补测绑定 Engine `4beb46f` 和 Native `5bf22e6`，两端使用同一对门禁 tarball。Mac 浏览器真实中文输入、缩放、折叠取消及列表回收通过。iPhone GUI／IME、旋转、键盘遮挡及后台返回通过，操作者确认居中有声及返回前台后恢复播放，日志记录音频恢复为运行状态。Native 全量在 macOS 上 188 通过、0 失败、0 跳过，在 Windows 上 183 通过、0 失败、5 项平台跳过。Engine 本机 2,696 项测试和 112 个示例构建通过。 [Apple 回传复核](../../artifacts/engine-0.2.3/g11/final-apple-retest/returned-20261110T131720/apple-physical-acceptance.json) [Mac Native 全量复核](../../artifacts/engine-0.2.3/g11/final-apple-retest/returned-20261110T134622/native-macos-full-acceptance.json)

运行编号、逐文件哈希、候选输入、未完成设备及正式入口状态只在 [G11 检查索引](g11-checks.json)维护；本页不重复追加执行时间线。

两份失败／被取代的运行副本和五份无现行引用的旧原型安装缓存已[离线归档](../archive/engine-obsolete-runtime-20261102.md)。原检查身份保持；复核旧文件时按索引映射读取或恢复，当前候选仍重新准备。
