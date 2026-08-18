# 阶段 12：Production Specialized Rendering Family

阶段 12 将 `InstancedMesh3DRenderer`、`Line3DRenderer`、Planar Mirror、Volume、纹理卷积、mipmap 与经纬图转 cubemap 作为一个受评审的 specialized-rendering family 迁移。输入是 [builtin-specialized-rendering-family.json](./builtin-specialized-rendering-family.json)，构建期编译为 Artifact V2；engine runtime 只物化生成 WGSL 与 reflection，不运行 compiler 或拼接 WGSL。

## Family 与 ABI

七个 pass 记录同一个 `specializedModuleHash`，并在生成期解析容量常量：Instanced Mesh 保持八盏灯，Line3D 保持八段圆头与每段 54 个程序化顶点。Scene frame 继续是 272 bytes；Volume 继续使用共享对象 storage table，不回退为每实体 uniform/bind group。Volume 主对象 record 保持 192 bytes，144-byte 裁剪 companion record 仅在裁剪状态变化时上传；raymarch 对每个采样点执行同一世界空间多平面判断，裁掉的区域不会贡献密度或颜色。纹理卷积固定 64-byte 参数、3×3 kernel、8×8 workgroup 与 `rgba8unorm` 输出。

四个场景渲染 pass 的 layout 仍由 renderer 拥有，以保留 SceneFrame、对象表、材质资源、透明排序及 render lifecycle。三个固定纹理 utility pass 的单组 layout 由 artifact 拥有。该边界允许固定实现共享编译器生成与缓存，同时不把 GPU 资源生命周期移进 shader compiler。

## Production 接线

`InstancedMesh3DRenderer`、`Line3DRenderer`、`PlanarMirrorRenderer`、`VolumeRenderer` 与 `TextureConvolutionProcessor` 通过私有 `BuiltinSpecializedRenderingShader` adapter 消费生成 artifact。`ImageTextureUpload` 与 `EquirectangularReflectionMap` 中的内联 WGSL 同样被构建期产物替换。旧五个 engine-owned WGSL 源移入 compiler-owned standard library；迁移清单当前覆盖 60 个 WGSL 源，其中 54 个为生成源、6 个为受控手写源。

真实 Chrome/WebGPU 门禁编译全部七个 pass，创建 renderer/artifact 两种 layout，并读回 mipmap 与 identity convolution 像素。bundle 门禁固定当前独立 artifact 的 raw/gzip 证据，并拒绝 compiler 实现或未解析 specialization 进入 engine runtime。

## 边界

本阶段把纹理卷积视为固定产品 pass，而不是通用 Compute IR。实例裁剪、透明深度排序、GPU draw command、bitonic sort 与 Mesh3D cull 仍在阶段 13 的 compute family；公开 `ComputeKernel` 原始 WGSL escape hatch 保留。本阶段不改变公开 package export、API baseline 或 WebGPU-only 产品契约，也不实现 GLSL ES 300、WebGL2 fallback、节点编辑器或稳定公共 Shader API。
