# 场景、实体与组件

## 实体层级

Hierarchy 展示场景实体树。右键空白区域或实体可以添加普通实体、2D 元素或子实体；拖拽节点调整父子关系。搜索不会修改真实层级，折叠状态在选择和过滤后保持。

## Transform 与 Gizmo

- `W`：位移。
- `E`：旋转。
- `R`：缩放。
- `F`：聚焦当前选择。
- **World / Local**：选择变换坐标系。
- **Pivot / Center**：选择多选变换中心。
- **Snap**：按指定步长吸附。

拖拽开始时编辑器记录原始值，拖拽过程中只更新预览，结束时提交一个命令。因此一次拖拽只产生一个撤销步骤。

## Inspector

选中实体后，Inspector 显示名称、ID 和组件列表。使用组件区域的 `+` 添加组件，使用 `−` 删除当前组件。多个实体同时选中时，共有字段可以批量编辑；不同值显示为 mixed value。

组件类型由 Editor Contribution 提供。贡献可以同时定义创建方式、Inspector schema、序列化、反序列化、资源依赖、Viewport 安装项和运行时导出，插件不应绕过贡献模型直接修改 Inspector。

### 多平面截取

选择带 3D 网格的实体，在组件区域添加 `ClippingPlanes`。Inspector 的 `World-space Planes` 是 JSON 数组，每项包含世界空间法线 `normal: [x, y, z]` 和平面常数 `constant`；保留满足 `dot(normal, worldPosition) + constant >= 0` 的部分。编辑器会拒绝零向量、非有限数值和超过 8 个平面的输入，并在提交时归一化平面方程。

该编辑走 CommandBus，支持撤销/重做；场景保存、Runtime Export 和 Player 反序列化使用同一个核心组件协议。它只执行片元截取，不生成封口几何。

## 场景系统

Systems 面板管理需要按帧运行的系统。只有明确属于场景行为的系统才应加入；材质渲染器、资源缓存和编辑器 UI 服务不应作为普通场景系统添加。

`NavMesh` 是从地形派生的运行时查询资源，`FirstPersonControls` 是持有 Canvas/Pointer Lock 监听的运行时 system；两者都不是 ECS 组件，当前不会出现在 Add Component，也不会被编辑器当作组件序列化。需要这类行为时应在游戏启动代码或专用 Editor Contribution 中构建、安装并在退出时 dispose。不要用 `DataComponent` 冒充运行时对象，否则保存结果只会保留普通 JSON，并不会自动创建导航或控制系统。
