# `@haiyue/extensions`

Extensions 包提供不属于引擎核心的可选完整能力，例如 glTF loader/Worker、Spine、动画运行时、插件工厂和 Canvas 文本组件。入口以 [`extensions/package.json`](../../extensions/package.json) 的 `exports` 为准。

## 0.1 稳定入口

- `@haiyue/extensions/gltf`：glTF loader、component/system/plugin、材质扩展与兼容报告。
- `@haiyue/extensions/animation3d`：来源无关的 clip/pose/mixer/layer/mask/event/state machine 与 HYA adapter。
- `@haiyue/extensions/gltf-animation3d`：把 glTF clips 适配到 Animation3D runtime。
- `@haiyue/extensions/animation`：Animation2D component/system、资产加载、渲染和状态机集成。
- `@haiyue/extensions/hya-state-machine`：聚焦的 HYA 2D 状态机 runtime。
- `@haiyue/extensions/spine`：Spine component、render system、plugin 与稳定 worker 接口缝。
- `@haiyue/extensions/tilemap`：Tilemap2D component、render system 与 plugin。
- `@haiyue/extensions/canvas-text`：Canvas text component 与 render system。
- `@haiyue/extensions/tween`：Tween2D component 与 system。
- `@haiyue/extensions/grid`：Grid2D component contract。

根入口在 0.1 中仍为 experimental。worker client/source builder 与 parsed asset 等底层协议分别从 `@haiyue/extensions/experimental/gltf-worker`、`@haiyue/extensions/experimental/spine-worker` 导入，不进入 stable runtime 合同。

扩展包可以依赖 engine 导出的 API，但 engine 不得反向依赖扩展。普通业务不应通过扩展包访问引擎 private 实现。加载器返回的资源句柄、兼容性报告和 disposer 仍遵守 Engine Guide 中的[资产生命周期](../engine-guide/asset-lifecycle.md)。

`@haiyue/extensions` 根入口只提供最小的扩展作者基础能力。glTF、Spine、动画等运行时必须从明确 subpath 导入，避免把可选能力带入基础启动闭包。

精确类型签名以构建后的 `extensions/dist/*.d.ts` 为准。

## HYA Animation2D 状态机

`@haiyue/extensions/hya-state-machine` 提供 `Animation2DStateMachineComponent` 与 `Animation2DStateMachineSystem`。它们消费 `.hya` 内建的 `org.haiyue.animation-state-machine@1` 扩展，在一份解析结果和一棵运行时节点树上播放多个命名 clip，并复用共享状态机、2D mixer、layer/mask 和 Blend Tree 语义。该能力使用独立子路径，基础 Animation2D 和编辑器首帧闭包不会为未使用的状态机付费。

应用通过 `setFloat()`、`setInteger()`、`setBoolean()`、`setTrigger()` 驱动 transition，通过 `layerSnapshots` 读取当前 state/transition。组件移除、Entity 离开 World 或 System 销毁都会释放生成的层级与 mixer action。完整格式和示例见 [`animation-spec/README.md`](../../animation-spec/README.md#单素材状态机)。
