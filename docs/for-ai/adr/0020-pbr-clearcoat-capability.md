# ADR 0020：PBR Clearcoat 能力与资产契约

- 状态：Accepted
- 日期：2026-07-17

## 背景

Metallic-roughness PBR、IBL、方向光阴影、材质 variants、动态 UV semantic 和异步 pipeline warmup 已形成闭环。下一项 shading feature 需要同时验证材质扩展、glTF extension、shader feature、pipeline key、纹理生命周期、编辑器编辑与产品回归，但不能把透明排序、scene color 或 shadow atlas 等新问题混入同一阶段。

## 决策

1. `PbrMaterial` 原生支持 clearcoat factor、roughness、normal scale，以及 factor、roughness、normal 三个独立纹理槽。
2. 三个 Clearcoat 纹理槽都是 linear 数据纹理。factor 使用 R 通道，roughness 使用 G 通道，normal 使用 RGB；它们复用现有 per-slot sampler、完整 mip chain、`KHR_texture_transform` 和动态 UV semantic planner。
3. Clearcoat 是独立的 `pbr.clearcoat` WGSL feature。renderer 为 off/on 生成不同的 shader define 和 pipeline cache key；Clearcoat 不创建透明 pass，不改变 opaque depth、shadow 或排序契约。
4. `KHR_materials_clearcoat` 被报告为 fully supported。optional extension 进入 compatibility report；required extension 只有在 loader 和 renderer 完整支持时才允许加载。
5. Clearcoat 不要求新的 WebGPU optional feature，因此支持现有 PBR 的设备无需降级。若基础 PBR/WebGPU 不可用，沿用既有 RenderProfile/device capability 失败语义，不静默删除 Clearcoat 层。
6. 编辑器资源详情、场景序列化、runtime export、clone、variants 和设备恢复必须保留全部 Clearcoat 数据与纹理引用。
7. 产品门禁必须覆盖 Clearcoat off/on、factor/roughness/normal 组合、IBL/阴影组合、真实 glTF required extension、pipeline key 分离、纹理销毁/recovery 和 PBR material benchmark。

## 范围外

- transmission、volume、折射和 scene-color sampling；
- cascaded shadow、shadow atlas；
- material graph 或通用 shader IR。

这些能力必须在 Clearcoat 门禁稳定后分别决策，不能通过扩大本 ADR 的实现范围进入。

## 后果

- PBR material uniform 和 bind-group ABI 增加三个纹理/采样器与 Clearcoat 参数，但仍低于 WebGPU 默认每阶段资源上限。
- Clearcoat on/off 是显式 pipeline 变体，warmup 数量增加；cache 诊断和 benchmark 负责阻止无评审退化。
- glTF、编辑器和 runtime export 不再需要把 Clearcoat 烘焙进 base roughness 或丢弃 extension。
