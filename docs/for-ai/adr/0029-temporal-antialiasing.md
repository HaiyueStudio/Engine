# 0029：视图级时域抗锯齿与后处理帧上下文

- 状态：Accepted
- 日期：2026-07-21

## 背景

现有后处理链只接收当前颜色和按需生成的深度、法线等场景纹理，Camera 投影也只产生稳定矩阵。TAA 需要在场景编码前决定亚像素抖动，并在后处理阶段拿到完全对应的当前帧矩阵和视图身份；把这些状态藏进示例或修改 Camera 组件都会破坏多视图、RTT 和帧快照边界。

## 决策

1. `PostProcessPass.getProjectionJitter()` 是后处理对场景编码的唯一前置贡献点。每个 view 在编码前查询 pass，首个参与者写入像素单位抖动；抖动只进入 `Camera3DFrameData`，不修改 Camera 组件。
2. 后处理获得只读 `PostProcessFrameContext`：稳定 view key、camera id、帧号、尺寸、深度约定、投影类型、近远面、抖动量以及当前 view-projection/inverse-view-projection。Render3D 在 pass 执行前复制矩阵，避免可变帧缓存泄漏。
3. `TaaPass` 使用每 view 双缓冲历史纹理。历史 RGB 保存时域结果，alpha 保存归一化线性深度；当前深度重建世界位置并投影到上一帧，再用历史深度拒绝遮挡变化。
4. 历史颜色必须经过当前 3×3 邻域包围盒裁剪。只有帧号连续、camera id 相同、尺寸和格式相同的历史可以参与混合；resize、格式变化、pass 卸载、显式 reset 和跳帧都会失效或释放相应资源。
5. 首版使用 8 样本 Halton(2,3) 序列，并提供 feedback、depth threshold、sharpness 和 jitter scale。TAA 输出显示颜色的同时写入历史，避免额外全屏复制。
6. TAA 复用现有线性深度辅助 pass，不新增场景遍历、对象表或材质分支。历史按 RenderView key 隔离，可与主视图和 RTT 共存。

## 公开 API

`@haiyue/engine/postprocess` 增加 `TaaPass`、`TaaPassOptions`、`PostProcessFrameContext` 和 `PostProcessProjectionJitterContext`。经本 ADR 审核，该稳定入口预算由 19 调整为 23；根入口不扩张。

## 范围外

- per-object motion vector、skinned velocity 和 reactive mask；
- temporal upsampling / dynamic resolution；
- history exposure compensation；
- 与多套投影抖动 pass 的组合，当前明确由首个参与者拥有抖动。

这些能力应在引擎拥有统一 velocity buffer 或动态分辨率契约后扩展，不能通过示例私有状态绕开 RenderView 生命周期。

## 验证

- FrameData 投影抖动不修改 Camera 的单元测试；
- Halton 序列、深度依赖和历史 reset 契约测试；
- `taa-postprocess` 示例使用 1× 场景采样、细线和动态遮挡目标，执行 GPU validation 并确认历史有效；
- engine/examples typecheck、engine tests、API surface、示例 catalog/build 和浏览器 WebGPU 验收。
