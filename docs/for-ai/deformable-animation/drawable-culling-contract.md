# Drawable culling 与 winding 合同

## 冻结语义

- HYDM `culling` 是来源无关的 drawable back-face 开关：`false` 双面绘制，`true` 保留正面并剔除背面。它不是 visibility、空网格跳过、bounds/frustum culling 或 draw-order 优化。
- Cubism Core 的 constant flag 表达 `isDoubleSided`；许可隔离 capture 边界仅执行一次 `culling = !hasIsDoubleSidedBit(flags)`。转换器/runtime 禁止再次取反。
- `culling` 是静态 topology metadata。跨 baked frame 改变会以 `E_CUBISM_TOPOLOGY_CHANGED` 失败；非法非布尔值由 capture/HYDM parser 以带 path 的格式诊断拒绝。

官方 Web renderer 在 setup-mask 与 ArtMesh 主绘制前都读取同一 drawable culling，并在 mesh draw 上冻结 CCW 为正面。参考：[Live2D Cubism Web Framework renderer](https://github.com/Live2D/CubismWebFramework/blob/develop/src/rendering/cubismrenderer_webgl.ts)。

## WebGPU winding policy

- HaiYue 2D triangle 的来源正面为 clip-space CCW；visual pipeline 明确设置 `frontFace: 'ccw'`。
- WebGPU viewport/左上角 framebuffer 约定不由应用额外反转 winding。Chrome texture-readback fixture 直接冻结“source CCW 可见、source CW 被 back-face culling 剔除”。
- 实际 model/world/projection 反射仍参与最终朝向：单轴负 scale 或显式 Y reflection 翻面，双轴负 scale 恢复原朝向。`culling=false` 时两种朝向均可见。
- Viewport 尺寸、scissor、resize 与多 view 不改变 pipeline culling identity。

## Renderer 与缓存

- `AnimationVisual2D.culling` 默认 `false`；HYDM runtime 把同一静态值赋给主 visual 和每个共享 mask-group source clone。
- normal/additive/multiplicative 主 pass、mask source pass 与 effect source pass 都使用该值。Fullscreen effect/present triangle 不代表 authored drawable，继续双面绘制。
- visual pipeline key 包含 `none:ccw` 或 `back:ccw`。时间推进、seek/loop、动作切换、opacity/order/vertex 更新、resize 与多 view 只复用有限 pipeline 状态，不重建模型或纹理 owner。
- 未知 visual culling 抛出 `E_ANIMATION_2D_CULLING_INVALID`；pipeline 创建失败包装为 `E_ANIMATION_2D_PIPELINE_CREATION_FAILED`，并携带 `$runtime.animation2D.pipeline` 与完整 pipeline key。
- Shared GPU owner 销毁/device replacement 会清空 pipeline map；runtime destroy/abort 继续幂等释放 data、texture 与 mask clones。

## 验证与 G16 corpus acceptance

- `extensions/test/deformable-culling.test.mjs`：CPU winding oracle、两态 key、非法值、pipeline error、main/mask clone、seek/loop 与 destroy 生命周期。
- `scripts/verify-deformable-culling.mjs`：真实 Chrome/D3D11 WebGPU texture readback，覆盖 CW/CCW、culling on/off、单/双轴反射、normal/additive/multiplicative、main/mask、多 view、resize、有限 cache 与新 device recovery。
- 早期 `review/candidates/live2d-culling-rice-candidate.json` 只证明 Rice 有 9 个 `culling=true` drawables；其 1 秒 pose 全部退化，因此不能单独证明正反面裁剪。
- G16 在相同 Rice runtime hash `sha256-082dea…eedc1` 上固定 `Tap@Body:0 / 0.75s`：9 个 culling drawable 都有非退化三角形并在水平镜像后翻转绕序。代表 `ArtMesh161` 为 source `23 CCW / 0 CW / 0 degenerate`，mirror `0 CCW / 23 CW / 0 degenerate`。
- 同配置官方 Core/HYA surface readback 的 max channel error `179`、mean absolute error `0.303789`、mismatch ratio `0.012517`；recovery 通过且无未分类失败。机器可验证 recipe、许可、文件 hash、逐 drawable path/winding 位于 G16 manifest/candidate，正式 baseline 仍由 G09 批准。
