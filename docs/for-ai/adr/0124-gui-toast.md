# ADR 0124：GUI Toast 短消息

- 状态：Accepted（本地开发候选，随下一 minor 发布）
- 日期：2026-10-15
- 后续调整：[ADR 0128](0128-toast-in-021-release.md) 将 Toast 纳入 0.2.1；仅取代本页的版本安排，原决定及实现语义保留。

## 决策

`@haiyue/engine/gui` 增加 `GuiToast`、`GuiToastOptions` 两个领域导出，不扩张根入口或 experimental 聚合。GUI 符号归属预算由 84 调为 86。此为新增能力，不发布为 0.2.x patch；游戏使用带独立版本的本地候选 tarball，不跨仓导入源码。

Toast 是单条、无交互的短消息，不创建 DOM、不依赖 Native。文字与可选借用图标在 popup 层绘制，覆盖普通内容，低于模态对话框；超长文字裁切，长说明仍使用 HelpDialog。普通布局参数负责定位。`show` 替换并重启当前消息，`hide` 立即取消，不隐式堆积队列。

`durationMs` 是完全显示的停留时间，`animationMs` 是单次进入/退出时间，单位均为毫秒；动画为有限的透明度和 8px 位移。GuiSystem 的统一帧标识保证每帧只推进一次；show 后首帧忽略之前的空闲 delta。按需渲染通过现有 `animating` 保持调度，停止/隐藏/禁用/设备丢失时取消，不保留后台计时器。停留期间仍请求帧，但不改变静态像素的上传机制。

图标生命周期归调用方。序列化保存配置及 iconKey，不序列化图标本身或瞬态进度；新增 `toast` 标签不发送给旧引擎。截图生成、相册权限、保存成功判断和缩略图飞行动画属于游戏，不放入引擎。

## 验证

单元覆盖渐入/停留/渐出、替换、零时长、非法 delta、暂停、多视图、穿透点击、popup 层与 alpha、序列化和图标所有权。最小可运行示例为 `gui-runtime`。游戏覆盖异步保存失败、销毁期间返回、缩略图复用与响应式终点。公开声明基线、包消费与浏览器实绘检查随实现一起验收。

2026-10-15 验证结果：仓库 typecheck、test（Engine 783 项）、build、modules/responsibilities/renderer-prepare、api/docs 检查通过。数独消费候选包通过 817 项游戏测试、21 项 Native 测试、Web/iOS 构建；浏览器 430×932 下确认图标与文字、截图预览、结束后清理，无控制台渲染错误。

`verify:engine-package` 已执行：真实 tarball 安装、公开入口导入、TypeScript 声明、GUI 消费构建通过，但总 gate 仍报告 `@haiyue/extensions/achievements`、`@haiyue/extensions/share-content` 缺少 focused packed consumer。用 `git show HEAD:` 读取未修改的扩展清单、预算、能力归属和 fixtures，调用同一个 `validateExtensionConsumerCoverage` 得到相同两项错误，确认为本次修改前已有覆盖缺项；未放宽校验。完整结果见构建产物 `artifacts/release/public-packages.json`。
