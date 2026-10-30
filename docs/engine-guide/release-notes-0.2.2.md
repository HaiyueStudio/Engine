# Haiyue 0.2.2 发布说明

0.2.2 已于 2026-10-31 发布，见[正式 Release](https://github.com/HaiyueStudio/Engine/releases/tag/v0.2.2)及[示例站点](https://haiyuestudio.github.io/Engine/)。本版重点是共享布局、GUI 交互、局部区域更新与 HYA 组合播放。Windows 完整全局门禁、无发布演练、产品候选对齐及 Mac／iPhone 具名验收已通过，完整状态见[验收结论](../../review/engine-0.2.2/README.md)。本页不代替设备验收或正式发布决定。

## 共享布局与 GUI

`@haiyue/extensions/layout` 提供不依赖 DOM、GPU 或 GUI 的布局核心，GUI 通过 `@haiyue/extensions/gui-layout` 接入，HYA 复用同一实现。支持已准入的 Flex／Grid 子集、显式测量、最小／最大尺寸、百分比、padding、gap、绝对定位及 LTR／RTL。它不是完整 CSS：任意选择器、自动 margin、ordering 和 baseline 对齐不在本次范围。接入、内容版本和释放方式见[共享布局指南](shared-layout.md)。

GUI 新增容器预设、分隔面板、稳定 ID 标签页、主题／九宫格和语义拖放。输入域协调 GUI 与场景的归属，支持键盘／手柄焦点导航；文本支持 Unicode 字素编辑、中文 IME 桥接及三击全选。可编辑文本默认使用 `text` cursor，按钮使用 `pointer`，可通过 `style.cursor` 覆盖。控件与生命周期见 [GUI 指南](gui.md)及[控件 API](../api/gui-controls.md)。

`@haiyue/engine/gui` 是独立消费入口，与主入口共享类型、资源和输入 owner。原同步 `createScene({gui:true})` 行为保持，完整 Engine 主入口仍包含 GUI 装配；需要显式按需加载时，应在应用侧建立独立导入边界。

## 静态 GUI 与连续视图

区域提供按需、单次、连续和禁用更新策略。静态 GUI 可复用已有像素，另一块 3D 视图继续刷新；全部区域静止时停止呈现，交互或资源变化重新唤醒。区域缓存仍可能参与完整画面的合成，不能仅靠 scissor 保存上一帧 canvas 内容。

保留像素缓存受八区域／64 MiB 上限约束，普通帧工作附件、MSAA 与退役重叠分别计量并纳入完整 GPU 资源要求。区域使用显式 experimental 接入，裁剪、历史累积、外部提交及后处理限制见[区域渲染指南](region-rendering.md)。

## HYA 组合能力

新增五个独立生产入口：`@haiyue/extensions/hya-player`、`/hya-text`、`/hya-layout`、`/hya-data`、`/hya-audio`。播放器整合资源、状态机、数据事务、文字／图像、布局、绘制与输入；其他入口可独立消费所需能力。资源更新与失败回滚遵循原 owner，停止或销毁时释放所持租约。OpenType 继续按需加载。

HYA 支持增量求值、静态帧复用和调用方已有区域的接入。音频宿主、解锁及平台行为仍由应用协调；不承诺任意 Rive 完整保真、通用脚本执行或所有来源素材能力一致。格式与能力边界见 [HYA API](../api/hya.md)，当前生产与真实输入资格见[验收结论](../../review/engine-0.2.2/README.md)。

## 升级与设备边界

四个发布包为 `@haiyue/engine`、`@haiyue/animation-spec`、`@haiyue/extensions`、`@haiyue/shader-language`，版本均为 0.2.2。按各包的公开 exports 使用稳定或明确标注的 experimental 子路径，HYA 格式和 Shader artifact 版本独立管理。

升级前保留原锁文件与完整版本集合，在独立消费者中验证安装、声明、渲染、输入和销毁。布局绑定应在所属 GUI root 释放前销毁；区域句柄和借用资源仍由创建方管理。回滚时恢复匹配的锁文件及包集合并重新构建应用，避免混用运行时、声明或格式版本。

本轮 Windows 已验证真实中文 IME、手柄、生产场景、资源生命周期、画质和原生全局门禁。同一候选包加具名 Native 宿主修复已完成 Apple SDK、签名安装及 iPhone 15 Plus／iOS 27.2 beta 的组合输入、音频和 VoiceOver 验收。平台字体差异、短时音频测量及已记录清理计数的范围见验收结论。10k HYA 场景保持诊断用途，不构成所有设备流畅运行的承诺。UI、Editor、Games、Native 和 App Store 提交保持各自的验收与发布流程。
