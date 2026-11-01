# 0.2.3 候选：游戏流程与 GUI 复合组件

本版正在 G11 集成验收，尚未发布。最终资格和未完成项由 [0.2.3 验收入口](../../review/engine-0.2.3/README.md)维护，不能沿用 0.2.2 的设备记录。

## 新增能力

- `@haiyue/extensions/scene-flow`：准备完成后切换场景；有界加载、进度、取消、竞争和失败保留当前场景。
- `@haiyue/extensions/character2d` 与 `/camera2d`：在原物理世界上提供 box／circle 角色移动、滑动、地面和平台判定，以及独立的平滑跟随、死区、边界和震屏。重力和跳跃仍由游戏提供。
- `@haiyue/extensions/input-actions`：借用原动作映射和设备采样，补重绑、冲突处理及配置恢复；键盘与浏览器手柄的轴方向一致。
- `@haiyue/extensions/gui-collections`：稳定 key 的虚拟列表与树，逻辑数据和有限行实例分开，继续使用原文本、焦点及输入法宿主。
- `@haiyue/extensions/gui-controls`：面包屑、徽标和折叠面板；原 `/gui-layout` 标签页支持文字左／右图标。详见 [控件指南](gui-controls.md)。
- 原 Tilemap 增加借用图集、脏块和可见窗口更新，保留纯色模式与静态零顶点上传。
- `@haiyue/engine/audio` 与 `@haiyue/extensions/audio`：原 mixer 上的音量配置、静音、淡出和 2D 声像／距离衰减，不改变 HYA 的精确采样时钟。

[Gameplay Kit](../../examples/gameplay-kit/index.html)把设置、加载、角色／相机、地图、集合 GUI 和音频连成一条实际流程。各能力也可通过 focused 入口独立导入；具体参数和边界见 [extensions 使用说明](../../extensions/README.md)。

## 版本与兼容

Engine、extensions、shader-language 的目标版本为 0.2.3；animation-spec 保持已发布的 0.2.2。extensions 要求配对 Engine `>=0.2.3 <0.3.0`。根入口、旧同步行为和序列化格式保持，不增加第三方依赖；实验性输入宿主及其余实验入口不会整体提升为 stable。

```sh
# 正式发布后使用；当前请使用验收清单中的本地 tarball。
npm install @haiyue/engine@0.2.3 @haiyue/extensions@0.2.3 @haiyue/animation-spec@0.2.2
```

复合控件借用图片和业务内容，销毁只解绑，不代替调用方销毁资产或嵌套控制器。可切换场景共用同一 GUI 系统时，资源所有权按实际使用它的管线计数，避免旧场景退出后提前释放仍在使用的顶点缓冲。

## 支持边界

角色首版只承诺约定的 box／circle 与平移平台；Tilemap 不生成碰撞或导航；GUI 不是完整 CSS／Ant Design 实现。游戏音频需要实际 AudioContext 和 StereoPanner 能力，缺失时明确拒绝；Native PCM 接口不等于 Web Audio 适配。

正式帧节奏、GPU 回归、画质和资源要求保持。全局门禁、无发布演练，以及 Windows 真实输入、Mac 和物理 iPhone 的最终候选验收，均须在发布前完成。
