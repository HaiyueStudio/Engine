# BVH Traversal Visualizer

运行：

```sh
npm run build:target -- example:bvh-visualizer
npm run preview:target -- example:bvh-visualizer
```

## 交互

- 左侧鼠标移动发射射线；右侧独立相机观察射线、包围盒和三角形，拖拽旋转、滚轮缩放。
- 灰蓝色是背景层级；橙色是通过包围盒测试的内部节点；绿色是通过测试的叶子及其中所有实际参与求交的三角形。
- 可选红色包括空间相离的节点和被当前最近命中距离剪枝的节点。它们不会执行该节点内的三角形检测。
- 白点为最终最近命中。绿色不等于命中：同一叶子中未命中的三角形也确实执行了求交。
- 左上角放大展示最近访问叶子的实际三角形局部投影，便于看清高面数模型中的微小三角形。
- “冻结当前射线”保留一次查询；回放、单步和滑块按这次实际记录依次展示节点，不重新求交。回放顺序是代码的遍历顺序，不是射线传播的动画。
- 背景层级只控制静态 helper 的密度；本次通过检测的所有层级都会显示。层级、红色节点开关等 UI 操作不重建几何体或 BVH。

## 几何体与数据来源

`createPathExtrusion3D` 将 64 边起伏截面沿 512 环封闭扭结路径挤出，生成 65,536 个三角形。
示例先启动两个独立观察画面，再生成几何体、构建 BVH。两个画面共用 CPU 几何体，分别管理自己的 GPU 资源。

新增的 **experimental** `@haiyue/engine/experimental/diagnostics` 适配器：

```ts
const inspector = createRaycastBVHInspector(geometry);
const snapshot = inspector.getSnapshot();
const trace = inspector.trace(ray, worldMatrix);
```

- 复用 `Ray.intersectMesh` 的原有缓存、构建和遍历算法，未复制一份近似的 BVH 实现。
- 快照包含只读的节点边界、父子关系、深度、三角形范围以及排序后的原几何体顶点索引。
- `trace.steps` 记录实际节点测试顺序和结果；接受叶子的三角形数量之和严格等于 `trace.triangleTests`。
- 包围盒计数包含整体几何体 broad phase；若它未通过，节点访问列表为空。
- 求交结果使用独立输出缓冲区，后续查询不会覆盖历史命中。`markDirty()` 后快照与缓存一起更新。
- 内部诊断挂钩仅在单次查询期间启用，通过 `finally` 移除；普通射线不分配遍历记录。
- 本次增加 1 个函数与 3 个类型，位于现有实验性诊断入口及其预留预算内；同步兼容聚合入口与两处 API 基线，不增加稳定根入口符号，也不公开可修改的缓存节点。

`BVHHelper` 按状态批量绘制节点边框，避免为整棵树创建上万个 ECS 实体。
高亮三角形使用原始叶子索引，少量法线偏移只用于避免绘制重叠，不影响实际求交。
射线、helper、高亮三角形和白点都不加入查询对象。

## 验证

```sh
npm run typecheck -w ./examples
npm run examples:catalog:check
npm run build -w ./engine
node --test engine/test/ray.test.mjs engine/test/raycast-bvh-inspector.test.mjs engine/test/path-extrusion-geometry.test.mjs
npm run build:target -- example:bvh-visualizer
```

诊断测试验证树覆盖与父子范围、实际裁剪计数、已检测但未命中的叶子、独立命中缓冲、变换、异常清理和几何体缓存失效。
浏览器检查鼠标命中/未命中、节点与面着色、冻结后旋转、单步/回放、背景密度切换和页面离开时的资源清理。
