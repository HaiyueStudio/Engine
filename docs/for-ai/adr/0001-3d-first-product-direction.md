# 0001：3D 优先的产品与技术方向

- 状态：Accepted
- 日期：2026-07-10

## 背景

仓库同时包含 2D、3D、GUI、Spine、tilemap、编辑器和多个游戏。若在资源有限时同时扩张 2D 与 3D 两条同等规模的产品路线，渲染架构、编辑器工具和验证矩阵都会持续分叉。

现有投入更集中于 3D：glTF/Draco/KTX2、GPU-driven batch、indirect draw、frustum/GPU culling、透明排序、后处理、RTT 和 3D 编辑器工作流已经形成基础。

## 决策

项目主线定位为 **WebGPU 3D 游戏运行时与配套场景编辑器**。

1. 引擎和编辑器的首要闭环是：导入 3D 资产、组装场景、编辑实体/材质/灯光、预览、调试和导出运行时。
2. 渲染能力主线依次建设可诊断的渲染 profile、glTF metallic-roughness PBR、shadow map、IBL/environment lighting、material variants 和 shader/material 扩展协议。
3. 2D、GUI、Spine、tilemap 继续维护稳定性和测试覆盖，作为组件/插件能力存在；在 3D 基线完成前，不与 3D 主线同时进行同等规模的功能扩张。
4. 3D 优先不等于所有 3D 功能优先。API 边界、严格类型、生命周期、device lost、编辑器架构和性能诊断仍先于新增渲染效果。
5. examples 和 games 的 slow gate 优先选择能覆盖 3D 资产、GPU-driven 和真实 3D 游戏工作流的目标。

## 后果

- 渲染和编辑器架构可以围绕明确主线收敛，减少双路线造成的抽象妥协。
- `billiards-3d`、`sokoban-3d`、glTF viewer 和 GPU-driven examples 成为代表性持续验证目标。
- 2D 能力不会删除，但新增 2D 大功能需要独立 ADR 说明它与 3D 主线的资源优先级。
- 如果未来改为 2D 优先，应新增 ADR 替代本决策，而不是在实现中逐步漂移。
