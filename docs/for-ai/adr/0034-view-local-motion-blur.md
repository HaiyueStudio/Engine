# 0034：动态模糊使用按需的 view-local motion-vector buffer

- 状态：Accepted
- 日期：2026-07-22

## 背景

只依赖深度和前后帧 ViewProjection 的屏幕后处理只能重建相机运动，无法表示独立实体的平移、旋转和缩放。把动态模糊逻辑散布到每个材质 shader 又会扩大材质 ABI、重复历史矩阵管理，并让主视图、镜面和 RTT 互相覆盖历史状态。

## 决策

1. `MotionBlurPass` 是显式 post-process pass，只声明 motion texture 依赖。未安装该 pass 时不创建 velocity texture，也不执行 motion-vector geometry pass。
2. motion texture 使用单采样 `rg16float`，存储 signed UV displacement：`currentUv - previousUv`。它与 scene MSAA attachment 解耦，并使用同尺寸单采样辅助深度完成最近表面选择。
3. `MotionVectorRenderer` 为每个稳定 view key 保存 previous ViewProjection，并为每 view/entity 保存 previous world matrix。camera id、逻辑帧连续性或 history revision 改变时，上一帧取当前值，首帧速度为零。
4. `MotionBlurPass.resetHistory()` 是镜头切换、时间轴 seek 和实体 teleport 后的显式失效协议。相机实体变化和断帧由 renderer 自动失效。
5. resolve shader 默认使用当前像素自己的 signed velocity，在 `[-0.5, 0.5]` 曝光区间做最多 32 次等权居中采样。`shutterAngle` 只控制帧间位移的物理曝光比例；独立的 `intensity` 提供美术增益，`maxBlurPixels` 提供确定的画面上限。
6. 可选的 `tile-neighbor-max` 重建先在固定 8×8 tile 中选择最大速度，再在 3×3 tile 邻域中确定稳定候选。全分辨率像素不再逐像素扫描并切换 5×5 邻居；静止轮廓像素只接收方向一致且具有有效速度的运动样本。`split` 与 `velocity` 诊断输出复用同一 resolve pass。
7. motion history 和实体 uniform buffer 按 view 隔离；停止出现的 entity/view buffer 在提交完成后退休。geometry 继续复用 device 级 SharedGeometry3DGPUCache，设备丢失时随 Render3D owner 一并重建。
8. velocity geometry pass 覆盖 opaque rigid meshes、最多 4 个 GPU morph target 与 skinning，并按“morph 后 skin”的顺序同时计算 current/previous position。每个 view/entity 独立保存上一帧 morph weights 与 joint matrices；history reset、镜头切换、几何替换或非连续帧都令 previous deformation 回退到 current，首帧速度为零。透明 alpha coverage 和 particle velocity 仍需要各自的 coverage/previous-state ABI。
9. 与 TAA 组合时推荐 pass 顺序为 Motion Blur → TAA。TAA projection jitter 可能给 velocity 引入亚像素级差值，但 `maxBlurPixels` 和 TAA history rejection 保持其有界；未来统一 temporal frame ABI 时再提供显式 unjittered matrices。
10. stable API budget 继续只包含 `MotionBlurPass` 和 `MotionBlurPassOptions` 两个概念；本次增加的是已有 options/class 的强度与诊断成员，motion renderer、tile textures 与 velocity store extension 保持内部实现。

## 结果

- 相机运动与刚体实体运动共享一张紧凑速度纹理，材质系统无需承担历史状态。
- 多视图不会互相污染 previous matrix；首帧、镜头切换和 seek 不产生全屏巨大拖影。
- motion blur 会增加一次 opaque geometry pass、一张全尺寸 `rg16float` velocity texture、一张供该 geometry pass 做遮挡测试的可复用 auxiliary depth，以及每像素可配置采样成本；开启 `tile-neighbor-max` 时再增加两张约 1/64 像素数的 `rg16float` texture 和两个小尺寸 pass。能力仍按 pass/模式安装状态付费。
- 透明、粒子和 trail 需要后续扩展 velocity contribution 模型。

## 验证

- 单测覆盖 pass 依赖、参数校验、history revision、tile/neighbor shader 结构和 motion texture 的按需格式；
- engine typecheck、模块边界和 API surface 检查必须通过；
- dedicated example 同时覆盖高频纹理旋转、真实 19-joint glTF 角色、轨道运动、相机 Orbit、MSAA、history reset、分屏、热图和运行时参数调整；
- 真实 Chrome/WebGPU 固定第 24 帧，解码截图并门禁 raw/centered/tile-neighbor/heatmap 的变化像素比例与平均色差，同时要求 validation error 为零。
