# ADR 0022：BVH Mesh LOD 的资源与空间索引边界

- 状态：Accepted
- 日期：2026-07-17

## 背景

大型 3D 场景需要按相机距离降低单个对象的顶点成本。每帧对全部 LOD 对象执行距离计算仍是线性 CPU 工作；把每档 LOD 表达为互相禁用的子实体，又会污染用户自己的实体可见性、交互和生命周期状态。

LOD 还必须处理相机连续运动产生的阈值抖动、对象变换后的空间索引失效、运行时资源替换，以及组件或系统移除时的资源恢复。

## 决策

1. stable 内容契约由 `BvhLod3D` 表达。层级按距离严格递增，最后一档必须以 `Infinity` 作为始终可用的 fallback；每档持有 geometry 和可选 material override。
2. `BvhLodSystem` 是显式安装、绑定相机的 BVH 诊断系统；它维护候选集和切换统计，但不拥有或修改 `Mesh3D`。真正的资源选择由 `RenderViewFrame` 在渲染收集阶段完成。
3. BVH 只索引“可能高于 fallback”的激活体积。激活体积是对象保守世界包围球加最大有限切换距离和滞回范围；相机点查询以外的对象保持最后一档，不执行逐对象精确距离选择。
4. 相机运动只查询 BVH，不触发重建。LOD 对象成员变化、Transform world version、组件 revision 或自动 bounds 所依赖的 geometry version 变化才使索引失效。
5. 精确距离使用相机到世界包围球表面的距离。切换采用分数滞回，升级和降级使用阈值两侧不同边界，避免相机在阈值附近导致每帧资源抖动。
6. BVH 节点、排序数组和对象状态是 system internal 实现，不进入 stable API。stable 只暴露配置、当前实体层级查询和聚合统计；后续可以替换为增量 BVH、宽 BVH 或 worker 构建而不改变内容格式。
7. system 记录接管前的 Mesh3D geometry/material。组件禁用、实体离开查询或 system 销毁时必须恢复原资源；未提供 material override 的层级必须使用该原始材质。
8. 当前能力限定为单实体 Mesh3D LOD。层级化 prefab、skinned mesh、impostor 和 streaming LOD 需要各自的资源所有权与加载失败策略，不能隐式塞入同一组件。多 view 的 hysteresis 状态按 RenderView key 隔离。

## 后果

- 静态大场景每帧只对相机附近候选做精确选择，远处对象无需重复写 Mesh3D。
- LOD 不占用实体禁用状态或 Mesh3D 资源所有权，交互、编辑器选择和用户脚本仍能稳定引用同一实体及其原始资源。
- 动态对象仍需要读取 Transform world version；在缺少 transform dirty event 的前提下，这是索引正确性的必要成本。后续引入增量空间服务时可以替换同步阶段而不改变 stable 内容 API。
- 多相机场景由 RenderViewFamily 派生独立选择状态；同一 Mesh3D 可以在同一帧为不同 view 使用不同 LOD，而组件本身保持不变。
