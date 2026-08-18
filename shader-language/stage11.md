# 阶段 11：Production Material Lighting Family

阶段 11 将 PBR、PBR Clearcoat、PBR Transmission、PBR Transmission + Clearcoat、Blinn-Phong 与 Toon 作为一个受评审的 material-lighting family 迁移。输入是 [builtin-material-lighting-family.json](./builtin-material-lighting-family.json)，构建期编译为 Artifact V2；engine runtime 只物化已生成 WGSL 和 reflection，不运行 compiler，也不再在三个 renderer 中组合 WGSL 文本。

## 单一光照与材质事实来源

Fog、PBR BRDF、Clearcoat、Sheen、directional shadow 和三个材质入口均位于 compiler-owned standard library。六个 pass 记录同一个 `lightingModuleHash`；四个 PBR 变体只在构建期固化 clearcoat/transmission 开关，不保留运行时占位符或复制 BRDF。Fog module 自包含 `FogUniforms`，同时供生成 family 与暂未迁移的受控 feature composer 消费。

当前 ABI v1 固定每个 scene snapshot 最多八盏灯。PBR 固定三个方向光 shadow slots，Toon 保持一个有效方向光阴影；这只迁移并冻结现有产品能力，不在本阶段引入 Forward+/Clustered 或 CSM。PBR material block 为 608 bytes，light block 为 528 bytes，三方向光 shadow block 为 240 bytes；PBR object record 保持 160 bytes，Blinn/Toon object record 保持 128 bytes。三者通过 group 1 binding 1 读取按 object slot 对齐、独立上传的 144-byte 裁剪块。Blinn material 为 64 bytes，Toon material 为 240 bytes。

## Deformation 与 layout ownership

四个 PBR 变体复用阶段 10 的 morph → skin module identity 和 current deformation ABI，不复制 sampler、skinning 或 morph 实现。Scene frame 继续使用 272-byte dynamic uniform；renderer 继续拥有四个 bind-group layout、GPU resource、透明排序和 pass 调度。Artifact reflection 是 layout 的构建期契约，不把 GPU 生命周期交给 compiler。

## Production 接线

`PbrRenderer`、`BlinnPhongRenderer` 与 `ToonRenderer` 通过私有 `BuiltinMaterialLightingShader` adapter 消费生成 artifact。旧的八个 engine-owned WGSL 源已移入 compiler standard library；统一生成注册表负责 stale check，迁移清单保持全部 58 个 WGSL 源都有唯一归因。

真实 Chrome/WebGPU 门禁编译全部六个 pass，按 reflection 建立 24 个 renderer-owned layouts，并读回 Blinn 环境光与光照后 Fog 像素。该证据专门防止 WGSL 占位符、缺失标准库声明和 reflection/renderer layout 漂移只在运行时出现。

## 边界

本阶段不迁移 instanced/line/planar-mirror/volume/texture-convolution 等 specialized rendering，不迁移 compute family，不改变公开 package export、API baseline 或 WebGPU-only 产品契约。GLSL ES 300 backend、WebGL2 fallback、visual graph editor 和稳定公共 Shader API 继续延期。
