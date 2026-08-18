# 阶段 2：Typed Expression IR 与最小 WGSL Backend

阶段 2 在 Composer 2.0 基础上加入真正的表达式级 Typed Shader IR。TypeScript authoring callback 只能调用结构化 builder；节点不包含 WGSL/GLSL/JavaScript 源码，backend 只消费通过验证的 IR。

## 已实现

- scalar/vector/square-matrix portable 类型，以及显式 `cast`、`splat` 和 vector construct。
- `value/position/direction/normal/uv/color/transform` semantic；position、direction、normal、UV 必须携带坐标空间，color 必须携带颜色空间。
- transform matrix 明确记录 `fromSpace -> toSpace`；matrix 类型、输入空间和目标空间必须全部匹配。normal transform 第一版只接受显式 `mat3x3<f32>` normal matrix。
- position/direction 代数：position ± direction 得到 position，position − position 得到 direction；position + position 被拒绝。
- stage 约束：derivative 和 implicit-LOD sample 只能进入 fragment；explicit LOD sample 可以进入资源 visibility 允许的其他 stage。
- uniform field、texture、sampler 继续使用 Composer 2.0 的符号资源，不允许 IR 指定 group/binding。
- canonical IR hash 忽略 source metadata 和不可达节点；最小 backend 对输出可达图执行 DCE，生成稳定 WGSL。
- node-to-generated-source map 保留 source id/name/line/column，浏览器编译信息可定位回 IR 节点。
- `defineTypedShaderModule()` 把 Typed IR 适配为阶段 1 `ShaderModule`，没有修改 engine 或 renderer。

PBR composition foundation fixture 已用 typed node 表达 texture sample、sRGB decode、world-height gradient、UV noise distortion、颜色因子与 roughness 输入。这只证明表达式/资源边界，不等于 Pilot 1 已完成；MaterialSurface、Fog/lighting lowering、像素对照和性能预算仍属于后续阶段。

## WebGPU 证据

独立 smoke gate 会在 Chrome 中执行 TypeScript builder，生成 WGSL，创建异步 render pipeline，绘制全屏三角形并回读中心像素：

```bash
npm run verify:shader-language-stage2
```

该 gate 要求 WGSL compilation error、WebGPU validation error 均为 0，中心 RGBA8 像素为 `51,204,102,255`（每通道容差 1）。阶段 2 尚未进入生产 renderer，因此该 smoke 暂不接入 slow/release gate。

## 明确延期

- array/struct expression、控制流、discard、storage write；
- 自动 varying/attribute allocation；
- MaterialSurface 和 Graph v1 lowering；
- 完整 constant folding/CSE、multi-pass derivation；
- GLSL ES 300 backend 与 renderer runtime adapter；
- PBR 生产迁移、engine export 和稳定公共 API。

权威机器范围见 [stage2-contract.json](./stage2-contract.json)。下一阶段应实现 MaterialSurface lowering 和 Graph v1 frontend，并完成 Pilot 1 的手写参考像素、变体、gzip 和 first-frame 对照；不能把当前 PBR foundation fixture 当作正式 fidelity 证据。
