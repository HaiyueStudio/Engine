# ADR 0065：实体级多平面渲染裁剪

- 状态：Accepted
- 日期：2026-07-31

## 背景

剖视、局部揭示、传送门过渡和编辑器检查需要在不修改源网格的前提下，只渲染多个平面共同保留的区域。把裁剪状态放入材质会使共享同一材质的实体互相污染，也无法可靠进入 GPU-driven 批处理；只在 forward pass 裁剪则会造成可见表面、深度、阴影、轮廓和 motion vector 不一致。

## 决策

1. `ClippingPlanes` 从稳定子路径 `@haiyue/engine/components` 导出，不加入根黄金路径；每个可渲染实体最多配置 8 个世界空间平面。
2. 平面方程为 `dot(normal, worldPosition) + constant >= 0`，满足所有平面的交集才保留。输入 normal 在赋值时归一化，constant 同比例缩放。
3. 裁剪状态属于实体，不属于 Geometry3D 或 Material。共享几何体/材质的实体仍可使用不同裁剪平面。
4. Basic、PBR、Blinn-Phong、Toon、depth、directional shadow、motion-vector、outline 和 normal pass 使用相同的世界位置与 discard 规则，禁止只修正最终颜色 pass。Volume 在 raymarch 采样点执行同一平面判断，使被裁区域不贡献密度和颜色。
5. 第一版采用片元裁剪，不生成截面封口，不改变 CPU 包围体和可见性剔除语义。需要实体化截面时应使用独立几何处理能力。
6. 每个 renderer 的主对象表保持原有 record 宽度；144-byte 裁剪数据位于同 object slot 的 companion storage buffer。矩阵、morph 或 skin 变化只上传主表，只有归一化平面数据的 `revision` 变化才上传裁剪表，多视图复用两者。
7. 平面随核心场景序列化，非法或超出上限的外部数据在反序列化边界被丢弃或截断到固定容量。

## 性能边界

- 固定上限保证 Shader ABI 与循环成本可预测；fragment discard 不减少顶点处理和 draw 数。
- companion buffer 增加 GPU 常驻存储，但避免把 144-byte 裁剪块乘入动态 transform 的每帧上传量；它复用 object bind group 的 binding 1，不增加 bind-group 数。
- 裁剪平面不是几何切割或 CSG 的替代品。大量永久静态裁切应在资产/几何处理阶段完成。
- 透明对象仍按现有规则排序并逐对象绘制；本能力不改变透明批处理策略。
- `InstancedMesh3D`、Line3D、PlanarMirror 等独立专用渲染系统不消费 Mesh3D 的 `ClippingPlanes`；需要时应在各自的实例/线段/反射语义下另行设计，不能伪装成普通表面裁剪。
- cap、InstancedMesh3D、Line3D 与 PlanarMirror 分别遵循 [ADR 0066](./0066-evidence-driven-large-capability-admission.md) 的真实内容准入，不因普通 Mesh3D 裁剪已实现而自动进入开发。

## 验证

- 单测覆盖归一化、容量、revision、clone、核心序列化和各生产 pass 的生成 Shader。
- `examples/clipping-planes` 使用两个共享同一 Geometry3D/PbrMaterial 的球体，只有其中一个实体应用三个动态平面，并通过方向光阴影验证 pass 一致性。
- `npm run verify:clipping-planes` 在真实 Chrome/WebGPU 中对关闭裁剪、三个平面和移动平面三种状态执行 validation 与像素差门禁；渲染器单测同时约束 companion clipping buffer 只在 revision 变化时上传并跨视图复用。该命令由 `verify:render` 消费，因此进入 slow/full gate。
