# Haiyue 0.2.0 发布候选

本页描述候选范围，版本尚未发布，正式发布仍需完成全部发布门禁。

## 新增能力

- `@haiyue/engine/experimental/audio`：`OwnerSafeAudioMixer`，按 owner 管理声音、混音与资源释放。
- `@haiyue/engine/experimental/simulation`：`BrowserMultiplayerInput` 与玩家输入快照。
  这两组入口继续为 experimental。
- Engine `/gui` 的 `GuiFontOptions`，以及 animation-spec 的 `AnimationTextStyleRun`，支持 GUI 字体配置与动画文本样式。
- `@haiyue/extensions/animation`：`InteractionRuntime`、路由事件、动作和几何端口，以及节点覆盖契约。
- `@haiyue/extensions/controls`：虚拟摇杆，支持固定/浮动中心、死区、2D/3D 移动、GUI 显示和输入清理。
  接入见[虚拟摇杆指南](virtual-joystick.md)。

## 包与兼容范围

四个公共包 `@haiyue/engine`、`@haiyue/animation-spec`、`@haiyue/extensions`、`@haiyue/shader-language`
版本统一为 0.2.0；请一起升级 Engine、animation-spec 和 extensions，避免混装 0.1.x。
Engine 默认入口仍为原有 30 个符号。HYA 数据格式和 shader artifact 版本保持独立。
本次范围不包含 Rive；UI、Editor、Games 按各自仓库独立发布。

完整 Animation2D 和 HYA 状态机导入包含字体轮廓解析器，下载体积随完整文本能力增长；
仅使用混音、输入或虚拟摇杆不会引入该解析器。

发布验证支持 Mac 或 Windows 完整原生 GPU 路径，见[浏览器与设备要求](browser-requirements.md)。Shader 与灯光验证详情见[专项评审](../../review/release-0.2.0-shader-lighting.md)。

候选的体积测量与剩余验证见[预算评审](../../review/release-0.2.0-capability-budgets.md)。
