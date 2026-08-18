# 0033：引擎原生 3D 粒子使用 view-local billboard 协议

- 状态：Accepted
- 日期：2026-07-22

## 背景

0032 将通用 2D 粒子放入 engine，但 3D 场景还缺少可复用的空间粒子能力。直接给 `ParticleEmitter2D` 增加 3D 模式会把屏幕空间与世界空间参数、Camera2D/Camera3D uniform、深度状态和透明排序混在一个组件及 renderer 中。多视图还要求同一 emitter 针对主相机、镜面和 RTT 生成不同的透明顺序。

## 决策

1. 新增独立的 `ParticleEmitter3D`、`Particle3DSystem` 和 `Particle3DRenderSystem`；不在 2D emitter 上增加模式分支。两者共享固定容量 SoA、可复现 PRNG、`restart/seek`、纹理与 blend 基础概念。
2. 3D emitter 使用本地空间 position/velocity，支持 point、box、sphere 体积源、锥形方向、三轴重力、尺寸/颜色/旋转生命周期，以及显式 depth test、depth write 和 sort mode。
3. 首版渲染形态为 Camera3D-facing billboard。实例 ABI 固定为 12 个 float：`center.xyz | size | rotation | padding.xyz | color.rgba`；实体 world matrix 在 vertex shader 中应用。
4. normal 透明粒子默认执行每 emitter、每 view 的 back-to-front TypedArray radix sort。view key 参与 GPU cache identity，禁止不同相机在同一帧覆盖同一实例缓冲。additive 默认不排序。
5. GPU instance buffer 按 generation 扩容，旧 buffer 必须在 submit 完成后退休；view/emitter 缓存停止使用后也走同一退休路径。系统参与 device recovery 和 GPU resource tracking。
6. 首版保持 CPU simulation + GPU instanced draw。GPU simulation、mesh particle、trail、跨 emitter 全局透明合并和 animation-spec `particle3d` 映射属于后续扩展，不改变当前实例 ABI 时可以增量加入。
7. stable API budget 经本 ADR 审核：根入口 418 → 427，`/components` 95 → 99，`/systems` 36 → 41。增长只包含 3D emitter、simulation、renderer 及其 options/stats 类型。

## 结果

- 2D 与 3D 粒子的用户 API 保持各自清晰，不为未使用的相机和深度路径付复杂度成本。
- volume emitter、billboard、深度遮挡和透明排序可直接用于游戏场景；固定容量仍保证 steady-state 无逐粒子对象分配。
- view-local 排序缓冲会随活跃视图数增长，但换取正确的镜面/RTT 顺序；停止出现的视图缓存会延迟一帧并在 GPU 完成后释放。
- normal 粒子的严格全局顺序当前只在单个 emitter 内成立。需要跨 emitter 精确混合时，应建立统一透明 draw-item/indirect 协议，而不是将所有粒子复制进临时对象数组。

## 验证

- engine 单测覆盖确定性、固定容量、seek、死亡槽复用、空间参数校验及 delta clamp；
- dedicated example 覆盖 additive fire/fountain/sparks、normal sorted snow、体积源、深度遮挡、MSAA 与 Orbit 相机；
- example 在真实 WebGPU 浏览器中检查 validation error、可见 emitter、实例数量和 view-local sorted count。
