# ADR 0057：Specialized Rendering 与固定纹理 Utility 采用同一生成期 Family

## 状态

Accepted

## 决策

1. Instanced Mesh、Line3D、Planar Mirror、Volume、纹理卷积、mipmap 与经纬图转 cubemap 作为一个 production specialized-rendering family 原子迁移，七个 pass 必须记录同一 module identity。
2. 八灯容量、Line3D 圆头段数与每段顶点数只在生成期 specialization；生产 artifact 不得保留模板占位符，runtime 不得组合 WGSL。
3. 四个场景渲染 pass 保留 renderer-owned layout、GPU resource、透明排序和 pass lifecycle；三个固定纹理 utility 使用 artifact-owned layout。
4. Volume 必须保持共享对象 storage table 与单对象透明 draw，不以迁移名义恢复每实体 uniform/bind group 或透明 direct instancing。
5. 固定 3×3 纹理卷积属于本 family；公开通用 `ComputeKernel`、实例裁剪/排序和其余 compute shader 留给独立 Compute IR 阶段。
6. mipmap 与经纬图转换的内联 WGSL 必须退休，生成产物进入统一 stale、bundle 与 Chrome/WebGPU 像素门禁。
7. 本迁移不扩大 engine public export，不更新 API baseline，也不改变 WebGPU-only 产品契约。

## 结果

- 七个生产消费者通过私有 `BuiltinSpecializedRenderingShader` adapter 消费 Artifact V2。
- 五个手写 WGSL 文件和两个内联 shader site 由 compiler-owned standard library 替代。
- 阶段 13 可独立设计 compute side effect、workgroup、buffer access 与调度 ABI，而不被固定纹理卷积的兼容需求绑架。
