# 0027：RenderViewFamily 多视图执行模型

- 状态：Accepted
- 日期：2026-07-18

## 背景

RenderPipeline 过去同时接受全局 `context.view` 和 entry-local `target`，同一个 pass 因而有两套 attachment 来源。多 viewport 只能安装多份 Render3DSystem，重复场景遍历、renderer/material/object cache、pipeline cache 和默认 GPU 资源。相机 LOD 系统还会把选择结果写回共享 Mesh3D，使两个视图无法同时选择不同资源。

## 决策

1. `RenderView` 是 camera、target、尺寸、viewport/scissor、depth/sample convention 和 load intent 的唯一组合边界，并拥有稳定 key。
2. `RenderViewFamily` 在 frame context 创建时一次性冻结。`context.view` 只保留为 family 第一项的 primary-view 投影，Render3DSystem 消费完整 family。
3. `RenderPipelineEntryOptions.target`、`RenderPipelineTarget` 和 descriptor bypass 被删除。Pipeline 的 attachment 只能来自当前 RenderView/RenderViewTarget。
4. Render3DSystem 每次 record 只创建一个 camera-independent `WorldFrameState`，其中包含 Transform、环境入口和可渲染对象。每个 view 再派生自己的相机矩阵、frustum、剔除结果、透明排序和 uniform slot。
5. renderer、material、object 和 pipeline cache 继续由一个 Render3DSystem 持有。相机 uniform 使用 view-local binding slot，避免同一 command buffer 内后写入的相机覆盖前一个视图。
6. `BvhLod3D` 只描述资源层级。view-local selection 写入 Render3DRenderItem 的 geometry/material/lodLevel，不修改共享 Mesh3D，也不取得其资源所有权。
7. 目前 GPU-driven batch buffer 是单视图 frame product。family 大于一个 view 时回落到共享 renderer cache 的直接提交路径；后续必须以 view-local batch slice 恢复 GPU-driven，而不能复用并覆盖同一 buffer。

## 验证

- 两个视图由一个 Render3DSystem 执行，camera-independent extraction 只发生一次。
- 两个相机可为同一实体同时选择不同 LOD，Mesh3D geometry/material 保持不变。
- 每个 view 使用独立 camera uniform slot，并保持自己的 target 尺寸、viewport、scissor 和 load intent。
- viewport-scissor 示例只安装一个 Render3DSystem。
- RenderPipeline API 不再存在 entry-local target。
- stable API budget 经本 ADR 审核：根入口 383 → 386，`/core` 65 → 68；增长仅包含 RenderViewFamily 及其 options/snapshot 类型。

## 后果

多视图成本从“复制整个渲染系统”收敛为“一次共享提取 + 每视图必要工作”。RenderViewTarget 成为 attachment 与尺寸的唯一来源，LOD 和相机缓存拥有明确的 view-local 生命周期。多视图 GPU-driven、每视图 post-process history 和跨 view shadow 复用需要继续沿 RenderViewFrame 扩展，不能重新引入 Engine 全局状态。
