# PBR、阴影与环境光

`PbrMaterial` 实现 glTF 2.0 metallic-roughness 工作流：base color、metallic/roughness、normal、occlusion、emissive、clearcoat、IOR/specular、sheen、transmission/volume、alpha mask/blend 和 double-sided。glTF 的 metallic-roughness、`KHR_materials_variants`、`KHR_materials_clearcoat`、`KHR_materials_ior`、`KHR_materials_specular`、`KHR_materials_sheen`、`KHR_materials_transmission` 与 `KHR_materials_volume` 直接映射到该材质，不再转换成旧光照模型。

`baseColor` API 使用引擎标准的 sRGB 颜色，renderer 在进入 BRDF 前转换为 linear；base-color、emissive、specular-color 与 sheen-color texture 以 sRGB format 采样，其余材质数据纹理保持 linear。Clearcoat factor 纹理读取 R、roughness 读取 G、normal 读取 RGB；Specular factor 与 Sheen roughness 分别读取 A。glTF 的 linear factor 会在导入边界转换，因此不会发生双重 gamma。

PBR renderer 通过 `AssetManager` 加载普通图片时会生成到 1×1 的完整 GPU mip chain。sRGB 槽位通过 sRGB texture format 在线性空间完成下采样，linear 槽位保持线性格式；KTX2/压缩纹理使用源文件提供的 mip chain。直接传入外部 `GPUTexture` 时，引擎不会重建其内容，调用方必须保证纹理与 sampler 所需的 mip 层一致。

glTF primitive 的 `POSITION` 与 morph target accessor 提供有效 `min/max` 时，loader 会为当前 morph 权重组合保守 AABB，并转换为 dynamic local sphere；skin 会在权重规范化后，仅使用实际影响该 primitive 的 joint matrices 转换该 AABB。morph 权重或 joint pose 改变时只更新 `boundsVersion`，不会使 vertex-buffer `version` 失效。任一必要 accessor bounds 缺失、非有限或无法证明时，`localBounds` 保持 `null`，渲染器继续 fail-open 跳过裁剪。

`LoadedGltfModel.compatibilityReport` 是冻结、可序列化的导入契约，汇总 used/required extension capability、每个 glTF texture 的 mipmap 来源，以及每个已实例化 primitive 的 static/accessor-conservative/fail-open bounds 状态。编辑器模型资源详情直接消费该报告并展示精确 issue code、glTF path 与降级原因；报告同时写入编辑器场景资源，因此重新打开场景后无需从 UI 重新推断兼容状态。普通编辑器纹理资源也会标明 `source-provided` 或 `base-level-only`，避免与 PBR glTF 导入时的自动完整 mip chain 混淆。

Importer 使用 `MaterialDescriptor` 描述材质，由 engine 统一创建具体实现。它不携带 importer schema，也不拥有 texture 或 GPU 资源：

```ts
import { createMaterialFromDescriptor, type MaterialDescriptor } from '@haiyue/engine/material';

const descriptor: MaterialDescriptor = {
  shadingModel: 'pbr-metallic-roughness',
  state: { baseColor: [0.2, 0.55, 0.9, 1], metallic: 0.8, roughness: 0.22 },
  variants: [{ name: 'damaged', state: { roughness: 0.8 } }],
};
const material = createMaterialFromDescriptor(descriptor);
```

产品或 importer 可以为单次 glTF 加载提供无状态 Extension Adapter。adapter 只返回 descriptor patch 与纹理语义；loader 仍负责资源、UV planning 和生命周期。相同 extension id 会替换默认 adapter，required extension 只有声明为 `supported` 才能加载：

```ts
import { loadGltfModel, type GltfExtensionAdapter } from '@haiyue/extensions/gltf';

const finishAdapter: GltfExtensionAdapter = {
  extension: 'VENDOR_material_finish',
  capability: { support: 'supported', note: 'Mapped to native PBR factors.' },
  extendMaterial: ({ extensionData }) => ({
    state: extensionData as { metallic?: number; roughness?: number },
  }),
};

const model = await loadGltfModel('/model.gltf', { extensionAdapters: [finishAdapter] });
```

默认 Clearcoat、IOR、Specular、Sheen 与 material variants 也走同一 adapter 路径。材质编译、预加载与动态 UV planner 共同消费 texture binding，因此扩展纹理的 sampler、transform、颜色空间和 `TEXCOORD_n` 不需要在 loader 中重复登记。

```ts
const material = new PbrMaterial({
  baseColor: [0.2, 0.55, 0.9, 1], metallic: 0.8, roughness: 0.22,
  clearcoatFactor: 1, clearcoatRoughnessFactor: 0.16,
  variants: [{ name: 'damaged', state: { roughness: 0.8, clearcoatRoughnessFactor: 0.55 } }],
});
material.setVariant('damaged');
```

`DirectionalLight({ castShadow: true, shadow: { mapSize, extent, near, far, bias, normalBias } })` 提供正交 shadow map 与 PCF。caster 候选集独立于主相机可见列表，因此相机外但仍处于光源正交视锥内的不透明对象可以正确投影；shadow pass 随后使用 conservative world sphere 做光源视锥裁剪，缺少可证明 bounds 的动态几何继续 fail-open。所有 caster 通过共享 storage object table 提交 model/morph 数据，不再为每个对象创建 uniform buffer 与 bind group。Basic 与 PBR 材质的 GPU morph、skinning 及组合变体会按“morph 后 skin”的顺序与主表面保持一致。

当前 forward scene snapshot 最多消费 8 盏有效灯。PBR 按稳定场景顺序为前 3 盏有效投影方向光生成独立 shadow layer；第 4 盏及之后的灯仍可参与照明，但没有 shadow map。当前没有 Forward+、clustered lighting、shadow atlas 或 cascaded shadow map；这组固定容量不构成大型场景或固定帧率承诺。Toon 路径只有一张方向光阴影，不能从 PBR 容量推断其行为。

PBR 角色几何支持最多 4 个 GPU morph target，并同时变形 position 与 normal；skinning 继续作用于 morph 结果。开启 `MotionBlurPass` 后，每个 view/entity 会保存上一帧 morph weights、joint matrices、model 与 ViewProjection，角色自身动画、物体运动和相机运动都会写入同一 motion-vector texture。默认动态模糊直接沿每个像素自己的 signed velocity 做居中采样；可选的 `tile-neighbor-max` 重建把运动表面稳定扩展到轮廓外侧。两种路径都保留 morph 与 skinning 的前后帧变形方向，并由独立的 `shutterAngle` 与 `intensity` 控制曝光比例和美术强度。

`EnvironmentLight` 接受 diffuse/specular cube texture；specular texture 应包含按 roughness 使用的预过滤 mip。未提供 texture 时使用显式的颜色 IBL fallback，因此低端设备仍有可解释结果。没有 `EnvironmentLight` 组件时不注入 IBL；组件的默认 diffuse/specular fallback 为中性灰，冷暖环境色必须显式配置，避免掠射角 Fresnel 被误读成材质自带的彩色轮廓。

Clearcoat 作为独立 `pbr.clearcoat` shader feature 接入；off/on 使用不同的 shader define 和 pipeline key，但继续复用 opaque depth、方向光阴影、IBL、Fog 与动态 UV planner。它不要求额外 WebGPU optional feature，设备降级语义与基础 PBR 相同。

Sheen 作为独立 `pbr.sheen` shader feature 接入。直接光使用 Charlie 分布和 sheen visibility，环境光使用 roughness 对应的预过滤 mip，并用方向反照率近似同时衰减下层 BRDF；Clearcoat 始终位于 Sheen 上方。两个 Sheen 纹理槽加入后，PBR fragment 阶段最坏使用 15 个 sampled textures，仍处于 WebGPU 最低 16 槽预算内。

Transmission 材质在不透明场景完成后进入第二个场景 pass：第一阶段的 resolved color 被复制为只读快照，第二阶段根据 IOR、厚度和粗糙度做屏幕空间折射与模糊，并使用 Beer-Lambert 衰减。`alphaMode` 仍表示表面覆盖率，不承担光学透射。

`examples/refraction-glass` 提供独立的玻璃球示例：高频不透明背景和移动色条让折射位移保持可见，并可实时调整 `transmissionFactor`、`ior`、`thicknessFactor` 与 `roughness`。厚度为零时走薄表面透射；厚度大于零时才会沿折射方向偏移场景颜色采样。

为保持 WebGPU 最低的 16 sampled-texture 限制，普通管线把最后两个材质绑定用于 Sheen 纹理；Transmission 管线在同一布局位置绑定 transmission/thickness 纹理。因此 Sheen 与 Transmission 同时启用时，Sheen factor 仍生效，但两张 Sheen 纹理不会参与 Transmission 变体。

扩展材质通过不可变 `MaterialShaderContract` 声明 shading model、顶点语义和 feature。参考实现在 `examples/pbr-showcase`；Clearcoat、IOR/Specular、Sheen 与 Transmission/Volume 产品基线命令为 `npm run verify:pbr-example`。
