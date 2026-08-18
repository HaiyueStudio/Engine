# 资源 ABI 与 Reflection

## 符号资源

Frontend 和 node 只能通过稳定 id 请求资源，例如：

```text
frame.viewProjection
object.model
material.baseColorTexture
material.noiseScale
pass.lighting.lights
pass.sceneColor
```

node 不得声明目标 binding 数字，也不得用字符串替换重映射 group/binding。资源 id、kind、value type、access、visibility、update frequency、color space 和 capability 共同构成请求。

## 逻辑资源空间

WebGPU v1 采用四个 portable logical space：

| Space | WebGPU group | Owner | Graph 权限 |
| --- | ---: | --- | --- |
| `frame` | 0 | view/frame runtime | 只读标准语义 |
| `object` | 1 | object/deformation runtime | 只读标准语义 |
| `material` | 2 | material instance | 可声明材质参数、纹理、sampler |
| `pass` | 3 | renderer/render graph | 只读声明 requirement；受信任 pass module 可写 compute resource |

逻辑 space 是 IR 契约；具体 backend 可以采用不同绑定机制，但必须保留 ownership 和 update frequency。现有 SceneFrame/Object/PBR ABI 是迁移输入，在 pilot 通过前不能被新 allocator 静默重排。

## 分配规则

1. engine-known ABI resource 使用登记过的固定 slot/layout。
2. extension resource 按 `space -> kind -> stable id` 确定性排序。
3. 相同 id 的声明只有在完整类型和 metadata 一致时去重。
4. texture 与 sampler 是独立资源；frontend 可以提供组合 helper，但 reflection 必须分别列出。
5. uniform field 先按 block/update frequency 聚合，再根据目标布局规则计算 alignment、offset 和 size。
6. CPU packer、WGSL struct 和 reflection 必须由同一个布局结果生成。
7. 超过 target limit 在 codegen 前失败，并列出每个 space/kind 的消费来源。
8. graph hash 对资源 id/type/layout requirement 敏感，对运行时 uniform 数值不敏感。

## Uniform ABI

每个 block 的 reflection 至少包含：

- stable block id；
- logical space；
- target group/binding；
- alignment、byte size；
- field name、type、offset、size、array stride、matrix stride；
- visibility 和 update frequency。

禁止 TypeScript writer 和 shader struct 分别维护 offset。runtime adapter 根据 reflection 创建 packer，内置固定 ABI 可以把生成结果提交为源码，但生成 schema 仍是唯一事实来源。

## Reflection v1

[reflection-v1.schema.json](./reflection-v1.schema.json) 定义编译结果交换格式，至少包括：

- target/profile 与 compiler version；
- canonical graph/IR hash 和 variant key；
- entry points；
- resource binding 与 uniform layout；
- vertex semantics 和 generated varyings；
- required capabilities/pass requirements；
- node/module 到生成源码的映射。

Reflection 是 renderer 创建 layout、packer 和 pipeline cache key 的输入。renderer 不得通过正则重新解析生成后的 WGSL 来恢复资源信息。

## Precompiled Artifact V2

[precompiled-artifact-v2.schema.json](./precompiled-artifact-v2.schema.json) 是构建期产物到 engine 私有 runtime adapter 的交付 schema。它保留 Reflection 的资源、uniform、vertex/varying、target、capability 和 source-map 信息，并增加每个 physical group 的 layout owner：

- `artifact`：adapter 根据完整 binding descriptor 创建 layout；
- `renderer`：SceneFrame、object table、material arena 等 owner 显式注入既有 layout。

V2 physical group 必须从 0 连续排列；logical space/group 不得漂移。外部 layout 对象身份进入 pipeline runtime cache key，但不进入 shader module 或 artifact-owned layout cache key。V1 只用于阶段 6 Motion Blur 的读取兼容。

阶段 8 的 builtin postprocess family 使用 logical `pass` group 3、physical group 0 和 `artifact` owner。纹理 sample type、sampler class、uniform byte size 与 TAA 双 render target 都来自 compiler reflection；production pass 不再复制 bind-group layout。`CustomPass` 的额外 group 仍由用户显式提供，属于保留的 raw-WGSL 边界。

## WebGL2 映射

GLSL ES 300 backend 可以把 logical space 映射到 UBO、uniform、texture unit 和 sampler state，但必须显式报告：

- storage buffer 无对应能力；
- compute/storage write 不可用；
- texture/sampler 数量或格式超限；
- dynamic offset/array binding 需要 renderer adapter；
- vertex/fragment limit 不一致。

这些结果是 capability diagnostic，不是自动 fallback。ADR 0044 的 WebGPU-only 产品契约在新的 renderer ADR 接受前继续有效。
