# Engine 0.2.3 验收入口

G01–G10 已完成，G11 仍在集成／验收。开发候选的 Engine／extensions／shader-language 为 0.2.3，animation-spec 为 0.2.2。原 `7236b39` 的 Windows 正式性能、全局门禁与无发布演练，以及 `de464ec` 的 Ubuntu CI 已通过；方向焦点及示例行编辑回收问题已修复并通过本地检查；当前候选仍需受影响的设备、云端及正式资格。整版未完成验收，未发布或推广基线。唯一活动检查入口为 [G11 检查索引](g11-checks.json)。

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

[当前设备包](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/engine-0.2.3-real-devices-307771a.tar.gz)约 18.5 MiB，5,322 个文件逐一回读校验。Windows 三个 current 入口及[Mac／iPhone 说明](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/README-current.md)已同步。Native 仅在已验证语料上应用具名试听配置与当前 vendor 包并重算来源；真实听音仍需设备记录。

当前 [Fast／跨平台无发布入口](https://github.com/HaiyueStudio/Engine/actions/runs/42457853186)和[完整 Ubuntu／SwiftShader CI](https://github.com/HaiyueStudio/Engine/actions/runs/42457859412)均通过。[当前 CI 复核](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/ci-acceptance.json)按官方 SHA-256 核对附件并保留全部原报告；只沿用已批准的 AO 600 秒调查项，保留原失败、部分样本及 8 次预热／30 次采样，不授予软件环境原生性能资格。

历史 `7236b39` 的 Windows 正式性能、资源／画质、全局门禁及无发布演练已通过，`de464ec` 的云端 CI 已通过。原平面反射、运动模糊、PBR、AO、MSAA、输入与灯光归档问题及解决证据在 [G11 索引](g11-checks.json)保留，各自结论仍绑定原候选。

## 未完成的资格

- 当前候选的 Windows [真实 IME](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/operator-stages/windows-ime.json)、[真实手柄](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/operator-stages/windows-gamepad.json)和[实际听音](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/operator-stages/windows-hearing.json)均通过。手柄覆盖导航、左右移动、B→X→恢复 B、起跳和长按只启动一次，退出后 GPU、关卡、世界和浏览器进程残留为 0。Mac 的中文提交、Esc 取消和 Chrome 进程退出已核对。操作者确认缩放后候选窗跟随光标，列表编辑回收后保留。修复候选 5d8041d 的真机折叠专项通过，收起后未选拼音已取消，重新展开保留原值。同一候选的正常选字和实际听音均已通过。物理 iPhone 已构建安装并回传，原候选复现了折叠残留拼音和 Badge 偏心，音频因原生宿主缺少 AudioContext 未能开始试听；旧记录保留原候选身份。
- 当前 CI 已通过；受影响正式资格仍需严格核对输入和哈希，不能自动沿用历史候选。
- 主工作区的 [29 项既存源码差异](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/main-source-binding.json)须在发布前统一；本轮十份 Engine 具名文件已一致，其他差异保留。

iPhone 的折叠预编辑与 Badge 居中修复已通过本地验证。验收页已接入 AVAudioEngine，真机听音、恢复和退出清理待复验。[iPhone 诊断包校验](../../artifacts/engine-0.2.3/g11/device-acceptance-20261107/iphone-remediation/iphone-retest-1794216680631/receipt.json)

运行编号、逐文件哈希、候选输入、未完成设备及正式入口状态只在 [G11 检查索引](g11-checks.json)维护；本页不重复追加执行时间线。

两份失败／被取代的运行副本和五份无现行引用的旧原型安装缓存已[离线归档](../archive/engine-obsolete-runtime-20261102.md)。原检查身份保持；复核旧文件时按索引映射读取或恢复，当前候选仍重新准备。
