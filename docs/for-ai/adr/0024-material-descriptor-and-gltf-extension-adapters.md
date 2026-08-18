# 0024：MaterialDescriptor 与 glTF Extension Adapter 边界

- 状态：Accepted
- 日期：2026-07-18

## 背景

glTF loader 过去同时解释 glTF 核心材质、识别扩展能力、枚举纹理与 UV、加载资源、转换颜色空间并直接构造 `PbrMaterial`。`KHR_materials_clearcoat` 和 `KHR_materials_variants` 因此散落在 loader、UV planner 和预加载路径中。继续增加 sheen、transmission 或产品自定义扩展会复制分支，而且 importer 会持续依赖具体 renderer class。

项目没有历史兼容负担，需要在更多材质模型进入之前建立长期边界，同时避免一个进程级可变 extension registry 影响多 viewport、测试隔离和并行加载。

## 决策

1. engine stable `/material` 提供 importer-neutral 的 `MaterialDescriptor`。descriptor 只描述 shading model、材质状态和 variants；`createMaterialFromDescriptor` 由 engine 校验 discriminator 并创建具体材质。Importer 不直接决定 renderer cache、GPU resource 或材质生命周期。
2. 当前 descriptor discriminator 仅接受 `pbr-metallic-roughness`。新增 shading model 必须先扩展 descriptor union 和 engine material factory，不允许 importer 通过类型断言绕过该边界。
3. glTF 扩展由无状态 `GltfExtensionAdapter` 解释。adapter 声明 capability，并可返回纯参数材质 state patch、纹理 slot binding、variant 定义与 primitive variant reference；state 类型显式排除 texture source、mapping 和 sampler，hook 不加载资源、不创建材质，也不持有跨 load 状态。
4. adapter 解析结果是每次 `loadGltfModel` 的不可变集合。自定义 adapter 按 extension id 替换默认实现；不建立全局可变 registry。required extension 只有在本次集合中声明 `supported` 才可继续加载。
5. loader 继续拥有 orchestration、资源获取/释放、texture/sampler 实例化和 concrete material materialization。`GltfMaterialDescriptor` 只把 glTF core 与 adapter patches 编译为 `MaterialDescriptor`。
6. 材质编译、纹理预加载与 `GltfUvSemanticPlanner` 必须消费同一个 texture binding 收集函数。扩展纹理不得分别在三条路径硬编码，否则会出现能加载但未规划 UV、或已规划但未预加载的分裂语义。
7. 默认 adapter 覆盖现有 Draco、BasisU、texture transform、clearcoat、variants 和 anisotropy capability。Clearcoat 状态/纹理及 variants mapping 从 loader 移入 adapter；现有功能不保留第二套兼容分支。
8. worker/parser 只验证并传递结构化 glTF 数据。函数型 adapter 不能跨 worker structured clone，因此 required-extension capability 在 `loadGltfModel` 拿到本次 adapter 集合后统一验证。

## 稳定表面预算

本决策批准 engine stable 根入口预算由 380 增至 383，`/material` 由 54 增至 57，对应 `MaterialDescriptor`、`MaterialDescriptorVariant` 和 `createMaterialFromDescriptor`。`@haiyue/extensions/gltf` 新增 adapter protocol、默认集合及组合 helper，并由 API baseline 精确追踪。

## 后果

- 新 glTF 材质扩展可在不修改 loader orchestration、UV planner 或 preload 分支的前提下接入。
- 相同 importer descriptor 将来可以映射到新的 renderer material 实现，而无需重写资产解释层。
- adapter 必须保持纯函数语义；需要缓存或资源的能力应通过 loader-owned port 另行设计，不能把所有权藏在 hook 内。
- adapter 可替换默认实现，因此产品可以显式禁用或重定义扩展；compatibility report 反映实际本次 load 的 capability，而不是全局常量猜测。
- stable API 有意增长，但增长局限于描述协议与单一 factory；glTF schema、descriptor compiler 和默认 adapter 实现仍为 components private。
