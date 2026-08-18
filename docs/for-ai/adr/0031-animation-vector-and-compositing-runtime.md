# 0031：动效 sprite、矢量路径与 alpha 合成运行时

- 状态：Superseded by [0032](./0032-animation-media-and-engine-particles.md)
- 日期：2026-07-21
- 取代：[0030](./0030-web-animation-intermediate-format.md)

## 背景

0030 确立了来源格式离线转换、HYA 运行时 IR 和独立扩展注册表，但首个 runtime 只实例化基础 shape。实际动效需要 image sprite、Bézier path、layer mask 和 track matte。把这些能力塞进通用 `Material2D` 会迫使普通 2D 材质承担纹理资源、路径构建和多 pass 合成；直接使用主深度/模板则会把 mask 与视图 MSAA sample count 绑定，增加多视图和后处理管线的组合风险。

## 决策

0. 保留 0030 的独立 spec 包、来源格式离线转换、HYA1 容器、秒/坐标归一化、扩展注册、严格 diagnostics 和不可信输入限制；本 ADR 取代其“首个 runtime 只渲染 rect/ellipse”及对应未来能力列表。
1. 在首次外部格式发布前，将 `path2d` 与 alpha composite 纳入 `haiyue-animation@1.0` core。路径使用紧凑 `M/L/Q/C/Z` command stream，values 与 tracks 共用 HYA1 连续 Float32 pool。
2. `sprite2d` 只引用 image resource。`Animation2DSystem` 使用场景共享的 `AssetManager` 异步加载，继承其去重、取消和 GPU 恢复机制；runtime 持有并在销毁时释放 `AssetHandle`。资源未就绪或失败时 sprite 保持透明。
3. 路径在 runtime 首次实例化时自适应 flatten 并由 earcut triangulate。缓存按已验证 component 身份复用 geometry；支持 `nonzero` 与 `evenodd`，不在每帧重新细分。
4. 动画视觉由专用、isolated 的 `Animation2DRenderSystem` 有序提交，不修改通用 `Material2D`。系统同时渲染 shape、path 和 sprite，时间轴系统不直接持有 GPU pipeline。
5. mask/matte source node 及其子树先写入每 view、每 source 的单采样 `rgba8unorm` alpha target，主 pass 再按屏幕坐标采样。这样 soft alpha、sprite alpha 和 inverted alpha 共享协议，也不依赖主 pass 的 MSAA/depth attachment。
6. alpha target 数量由 `maxMaskTargets` 限制，并通过 `maskTargetCount`、`maskPixels`、`droppedCompositeCount` 暴露预算结果。尺寸变化或闲置 target 在 submit 后退休，避免释放仍在 GPU 使用的 texture。
7. 1.0 只允许单层 composite。悬空、自引用、环和 nested composite source 在 parser 阶段失败。Lottie converter 支持静态 path、additive alpha mask、alpha/inverted track matte；动画 path、其它 mask boolean mode、luma matte及 mask+matte 组合产生结构化诊断，strict 模式阻止有损导入。

## 结果

- 来源 parser、动画时间轴、GPU 渲染和通用 2D 材质保持独立；新增来源格式不会进入页面 runtime bundle。
- 每个活跃 mask/matte source 会增加一个视图尺寸的 4-byte-per-pixel target，调用方必须按产品规模设置预算并监控统计。
- path 的动态形变尚未进入 core track ABI；转换器只能采样静态几何。若后续需要 morph，应设计拓扑稳定的独立数据块与 GPU 更新协议，而不是每帧重跑通用 tessellation。

## 验证

- parser/binary 覆盖 path zero-copy、sprite 资源类型和 composite graph；
- tessellator 覆盖 curve、hole、fill rule 与 geometry identity cache；
- runtime 覆盖 sprite load、pending/failure stats、取消和 handle release；
- Lottie converter 覆盖静态 path、mask 与显式 `tp` matte source；
- example 覆盖 Lottie → HYA1 → parser → sprite/path/mask/matte WebGPU 完整链路，并检查 GPU validation scope 与 composite 预算统计。
