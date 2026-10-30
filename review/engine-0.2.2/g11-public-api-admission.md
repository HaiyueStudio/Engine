# G11 公开运行时与 GUI／文本协调提案

当前结论（2026-10-24）：用户已批准最新 62 文件具名扩展，完整 135 文件候选（134 份补丁及 1 份已有回归）已按 SHA-256 核对并应用。以下是保留的隔离提案历史；旧“待准入／尚未应用”描述不再代表当前接入状态。[现行授权与应用记录](../../artifacts/engine-0.2.2/g11/admission-20261024/result.json)。门禁预算保持，G11 尚未完成。

问题：五个 HYA 运行时入口、GUI 依赖边界与纯文本入口需要进入同一个可消费候选。旧 API 提案漏记了五个既定入口的源码路径；公开字体合同也遗漏运行时已使用的编辑视口标志与光标／选区几何。许可必须随实际包交付。

方法：合并原 22 份共享文件与 36 份 Engine 候选（三份重叠），再补 Engine Unicode 许可，共 **56 份具名文件**。G11 自有的 19 份运行时覆盖另列清单。复用原 owner、G06 编辑器与固定 Unicode 字素算法；公开字体仅补两个既有可选成员，不新增文本符号。API 基线按原脚本序列化，五份 source 注记补齐，符号和预算不变。私有 bidi 内核的 MIT／Unicode 全文分别核对源码和实际 tarball。

结论：**提案已可审查，尚未应用生产或授予 API／发布资格**。原根入口保持，格式为 55 项，Player／text／layout／data／audio 为 9／7／5／9／7 项；纯 Engine text 仅公开 `textGraphemeBoundaries`。原冻结记录、失败和全部预算保留。

| 验证 | 当前结论 |
| --- | --- |
| 原 API 检查器 | 在合并全部覆盖的隔离源码上通过，根 API 与能力数量不变 |
| 构建与实际包消费 | 原格式／扩展构建通过；最终许可齐全的 tarball 重跑严格类型及 61 项公开工厂／组件检查通过 |
| 字体编辑合同 | 正反类型检查通过；真实字体宿主只消费公开类型，原 G06 双 DPR 各 25 项通过 |
| 独立图像／回滚 | 12 对 PNG 独立重读，最大通道差异 1，原容差 2；错误几何失败保留上一帧，同序列重试只提交一次，GPU 残留 0 |
| 字节一致 | 类型补齐前后 58 份扩展 JS 完全一致；最终重包的 Engine／扩展 JS 与声明全部保持 |
| Engine 总包体 | packed 2,015,937／2,100,000 B，unpacked 8,395,693／9,000,000 B，均通过 |
| GUI/font 硬门禁 | **84,532／55,000 B，仍失败，超出 29,532 B** |

真实字体仅覆盖三个固定拉丁变体配置，不能替代完整复杂整形／变体 profile、物理 Native、生产性能或全局门禁。原生组合、惰性加载及既有生命周期证据见关联记录，不能据此宣布 G11 完成。

具名范围：[56 文件清单](../../artifacts/engine-0.2.2/g11/coordinated-runtime-gui-text-v2-proposal/manifest.json) · [完整共享补丁](../../artifacts/engine-0.2.2/g11/coordinated-runtime-gui-text-v2-proposal/coordinated-shared.patch) · [G11 运行时覆盖](../../artifacts/engine-0.2.2/g11/coordinated-runtime-gui-text-v2-proposal/runtime-manifest.json)。该范围替代先前未答复的 22 文件请求，不增加包体、性能或像素预算。

协调依据：[G13 合同](../../../milestones/milestones/m23-engine-0.2.2/goals/g13-integration-release.md)规定“G13 拥有共享 exports、构建入口、API 预算、示例 manifest、正式报告和里程碑状态的串行集成写入权”；[milestone.json](../../../milestones/milestones/m23-engine-0.2.2/milestone.json) 的 G11 具名范围尚未包含这批共享及额外 GUI 文件，因此应用前需要此次明确协调授权。

[统一验证记录与哈希](../../artifacts/engine-0.2.2/g11/coordinated-admission-record-1792829000912821600/result.json) · [公开字体编辑证据](../../artifacts/engine-0.2.2/g11/public-font-editing-record-1792828947922418100/result.json) · [GUI 组合基础](g11-gui-capability-boundary.md) · [文本基础与剩余范围](g11-shared-grapheme.md)

G11 自有范围的两份文本实现另修正字距分配、RTL 归属／逻辑对齐及移词行高。当前候选的 61 项公开检查、26 项原文本、7 项 GPOS 几何、8 项字体优先级和 9 项按需加载检查通过；双 DPR 各 24 项双后端绘制、30 次原 G06 光标投影及各 195 项原播放器回归通过，324 对 PNG 独立重读符合原容差。五个公开声明入口不变。[当前运行时覆盖与证据](../../artifacts/engine-0.2.2/g11/production-bidi-spacing-record-1792832530982623900/result.json)不改固定 56 份共享候选，也不扩张待答复的七份额外 Engine 优化范围；生产仍未应用。

后续两份 G11 自有音频实现修正异步队列与同步前置检查的状态错位；六项确定性时序／默认检查、原 23 项音频及 61 项公开检查通过，双 DPR 各 8 项七部分实测和各 195 项播放器回归通过。[音频修复与原资源失败](../../artifacts/engine-0.2.2/g11/audio-transport-admission-record-1792833589569632400/result.json)保留。

当前另完成 `Animation2DRenderSystem.ts` 的绑定组所有权修复，使用现有公开 Engine experimental 接口，未增加 Engine 源码或 API。双 DPR 各 2,048 次七部分更新、28 项生命周期及各 195 项播放器回归通过，五个 HYA 公开声明保持。自有覆盖清单现为 22 份，固定共享 56 份及额外 Engine 七份均未改变；生产尚未应用。extensions 总包容量及许可白名单仍未获准入，原硬门禁失败与 GUI/font 失败均保留，不能授予完整候选资格。[当前运行时覆盖与验证](../../artifacts/engine-0.2.2/g11/animation-bind-group-ownership-record-1792834611604392500/result.json)。


图像宿主问题：底层纹理 owner 已有平台解码／快照端口，公开 Player 没有转发，关闭浏览器默认解码入口后旧包在 core 图片处失败，注入宿主调用为 0。方法：只补可选 `HyaPlayerHost.images`，捕获方法后同时接入原 core／layout owner；省略时保留浏览器默认，资源 SHA、尺寸、上传、恢复与租约规则不变。Player 仍为九个公开符号，其余四个 HYA 声明入口不变。

图片宿主及 Native 通用适配器的原 288 对像素、取消／设备恢复检查保留在[图像宿主证据](../../artifacts/engine-0.2.2/g11/public-image-port-record-1792835893379863100/result.json)。Native 七部分示例现已装配并推送，SDK 声明类型和 iOS JavaScript 打包通过；Apple 编译、真实模块元数据及设备资格仍缺失，见 g11-checks.json 的 nativeStandaloneAppPreparation。生产源码、共享 API 尚未准入。

包体问题：extensions 重复内置已经声明的 OpenType 依赖，加上未压缩 JS，原包为 776,007／550,000 B packed、3,785,967／3,000,000 B unpacked；独立许可文件另被白名单拒绝。方法：沿原动态 import 使用现有依赖；仅压缩排版／局部变量，保留函数和类名、许可注释、全部声明及 WGSL；完整第三方声明逐字合入 LICENSE。隔离 Rollup 重新构建为 **507,687／550,000 B packed、1,984,210／3,000,000 B unpacked**，原字节上限和白名单通过。386 份源码、176 份声明、17 份 WGSL 字符串和 26 个公开入口形状不变；原 61 项、纯求值七项、真实字体／WAV CPU 四项和双 DPR 各 195＋8 项 GPU 检查通过。282 对 PNG 符合原容差，原 276 张逐像素不变。[包体方案与完整验证](../../artifacts/engine-0.2.2/g11/compact-package-record-1792842058052701700/result.json)。

待协调项：旧加载检查的两份 OpenType 标记依赖编译文件名的哈希分隔符，外置依赖后仍保留原失败；候选只统一文件身份前缀，实际约 98.8 KB 的解析器仍计入延后／总量，提前加载与缺失负例均拒绝，所有数字预算保持。新[59 份共享候选](../../artifacts/engine-0.2.2/g11/coordinated-runtime-gui-text-compact-v3-proposal/manifest.json)继承原 56 份，其中 54 份候选字节不变，修改原 Rollup／包文件清单，新增 worker 构建、LICENSE 和加载标记配置三项；[五文件增量](../../artifacts/engine-0.2.2/g11/coordinated-runtime-gui-text-compact-v3-proposal/compact-build-delta.patch)尚未应用。自有 22 份及额外 Engine 七份分别保留。GUI/font 仍为 80,006／55,000 B，物理 Native、完整 profile 与最终门禁未通过，不能据包体方案授予 G11 或发布资格。

Native 场景另发现首帧尚未提交即开始绘制、GUI 清屏覆盖 HYA、横竖屏输入区域偏移及动作未使用限定 ID。示例现在以原零时差请求等待首帧，使用公开 pass API 并结束自有 pass，随后 GUI 加载已有颜色；补齐原 G06 声明并统一文字／输入／语义矩形。UIKit 语义投影使用独立子容器和稳定节点，动作、播报、后台及销毁仍由原 owner 管理。28 项 CPU／模拟边界、真实 SDK 类型和 iOS JS 打包通过；同一公开候选与真实资产在三个浏览器尺寸完成真实字形／PNG／按钮像素、可信指针单次事务与声音及零 GPU 残留检查。此前失败完整保留，[记录与哈希](../../artifacts/engine-0.2.2/g11/native-scene-os-record-1792844187054/result.json)。Apple 编译、元数据与物理 iPhone／VoiceOver 仍未验证。GUI 发布代码压缩的隔离调查最低 77,897／55,000 B，仍失败、未应用，不能替代原门禁。

字体位图问题：按完整样式缓存 Canvas 会保留历史像素；直接销毁旧缓存又会使旧帧或异步快照失效。当前候选缓存有界的不可变栅格描述，仅在原纹理 owner 请求快照时租用真实 Canvas，独立图像继续由原 GPU 租约持有。旧描述淘汰后仍可重放；字体在最后一个活动快照结束后释放，别名快照明确拒绝，清理失败时释放未交付图像并保留所有原因。单层 alpha 优化继续保留，多层 paint 合成方式不变。

结论：512 帧颜色／字号／多层样式变化没有持续保留栅格像素；2,048 种样式均可处理，缓存仅保留 1,024 份描述，不增加场景限制。11 项真实浏览器生命周期检查、原 22 项纹理断言、61 项公开消费以及双 DPR 各 195／24／6 项播放器／渐变／设备恢复检查通过。324 对 PNG 独立解码符合原容差 2，8,192 个 PCM 样本符合原容差；176 份声明、26 个入口及 17 份 WGSL 字符串不变。两份既有源码变化、增加一份私有 helper，紧凑包为 **508,411／550,000 B**。[当前证据与原失败](../../artifacts/engine-0.2.2/g11/font-bitmap-lifetime-record-1792846733780/result.json)和[23 份自有覆盖](../../artifacts/engine-0.2.2/g11/font-bitmap-lifetime-record-1792846733780/runtime-manifest.json)仍是隔离候选；固定 59 份共享清单和全部数字预算保持。旧[单层透明度证据](../../artifacts/engine-0.2.2/g11/font-opacity-cache-record-1792845277333/result.json)保留。物理 Native、完整字体 profile、生产性能和全局门禁尚未获准入，G11 未完成。
