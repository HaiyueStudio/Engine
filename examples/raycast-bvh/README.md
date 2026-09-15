# Raycast BVH

点击球体，用同一条世界空间射线分别调用 `Ray.intersectMesh` 的 BVH 和线性遍历路径。
彩色线从命中点沿 `RayHit.normal` 延伸，使用实际三角形面的法线，而非球体的平滑顶点法线。
白色十字表示该面的切平面。拖拽旋转、滚轮缩放；切换显示模式保留本次测量结果。
点击背景清除标记，并显示此次未命中的实际计算量。

## 计量口径

- `RayIntersectMeshOptions.stats` 是现有选项上的可选输出对象；不改变默认 BVH 开关或命中结果，不新增入口或导出符号。
- 每次调用重置 `triangleTests`、`boundingBoxTests`；计数包括未命中的检测，包围盒数包括物体 broad phase 和访问的 BVH 节点。
- BVH 在交互启用前预热，首次构建加预热耗时单独显示。计数不包括构建过程。
- 点击耗时包含一次求交和可选计数，不包含射线生成、法线绘制或 DOM 更新。两次调用使用独立结果缓冲区，交替测量顺序。
- 三角形检测比例条使用相同的物体三角形总数作为分母；不把包围盒检测与三角形检测相加当成等价操作。
- 手动批量测试每帧运行 24 对射线，累计求交耗时，不包含帧间等待，不开启计数；不会覆盖点击数据。

## 验证

```sh
npm run typecheck -w ./examples
npm run examples:catalog:check
npm run build -w ./engine
node --test engine/test/ray.test.mjs
npm run build:target -- example:raycast-bvh
npm run preview:target -- example:raycast-bvh
```

浏览器检查：初始演示法线可见；点击不同球面位置更新数据且两种结果一致；
切换模式改变颜色但不重新求交；旋转后法线仍固定在原命中面上；点击背景清除标记；
拖拽不计为点击；批量测试期间仍可交互，离开页面后无残留回调。
