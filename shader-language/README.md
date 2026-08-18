# Haiyue Shader Language

阶段 14 的 Typed IR → GLSL ES 3.00 可行性闭环见 [stage14.md](./stage14.md)。同一 IR 已在真实浏览器分别通过 WebGPU/WGSL 与 WebGL2/GLSL 的编译、绑定和像素一致性验证；这不代表 WebGL2 renderer 已交付。

本目录是 Haiyue shader 组合系统的独立规范与 private workspace。阶段 0 冻结架构契约，阶段 1–5 建立 Composer、Typed IR 与三个 Pilot，阶段 6–8 建立 Artifact runtime 并迁移 Motion Blur/内置后处理，阶段 9 批量迁移 2D/UI 与 simple-3D，阶段 10–13 原子迁移 deformation、material-lighting、specialized-rendering 与 compute family，阶段 14 验证 GLSL ES 3.00 codegen；尚未提供稳定公共 API，compiler 也不进入 engine runtime。

系统的核心不是另一套 WGSL 文本语法，而是一个带类型、stage、坐标空间、资源和 capability 信息的 `Typed Shader IR`。TypeScript DSL、编辑器节点图和未来可能出现的文本语法都必须编译到同一份 IR；后端已可从同一 IR 生成 WGSL 与受限的 GLSL ES 300。

## Shader Language Lab

[`examples/shader-language-lab/`](../examples/shader-language-lab/) 提供可交互 showcase，浏览器只加载构建期 artifact，不携带 compiler。页面包含三条证据链：同一 Typed IR 的 WebGPU/WGSL 与 WebGL2/GLSL ES 3.00 像素一致性；真实 Material Graph 的 albedo、法线贴图、UV noise、高度渐变、metallic/roughness 与 Fog 组合；真实 19-joint glTF/Animation3D 角色在 forward、depth、shadow、motion、outline 五个 Pass 中共享 morph → skinning → displacement 和 history ABI。Inspector 可以在 Composition、IR、WGSL/GLSL 与 reflection 间追踪 provenance。GLSL 仍只覆盖阶段 14 明确支持的可移植子集，不改变引擎 WebGPU-only 的产品契约。

```bash
npm run shader-language:generate:showcase
npm run verify:shader-language-lab
```

## 当前状态

- 阶段：14，GLSL ES 3.00 vertex/fragment codegen feasibility 已完成；阶段 13 的五个 production compute pass、Artifact V2 与全部既有 ABI 继续冻结。
- 稳定性：private npm workspace，不进入 engine root/experimental export。
- WebGPU：WGSL 是第一个实现后端。
- WebGL2：codegen feasibility 已有双后端像素证据；renderer、资源生命周期与功能降级尚未实现，现行 WebGPU-only 产品契约不变。
- Material Graph PBR：metallic-roughness lowering v1 消费 7 个基础 Surface 槽位；clearcoat、transmission、thickness 与 sheen 等高级槽位已建立精确拒绝契约，尚未实现通用 Graph lowering，不能视为可用或被静默忽略。
- Graph v1 root：仅支持 7 个必填字段和 `sceneFeatures`/`metadata`；lighting model、coverage、vertex displacement 与 pass requirement 仍由各自 compiler/renderer contract 拥有，不能作为 Graph root 字段写入。
- 权威机器契约：[stage0-contract.json](./stage0-contract.json)
- 阶段 1 机器边界：[stage1-contract.json](./stage1-contract.json)
- 阶段 2 机器边界：[stage2-contract.json](./stage2-contract.json)
- 阶段 3 机器边界：[stage3-contract.json](./stage3-contract.json)
- 阶段 4 机器边界：[stage4-contract.json](./stage4-contract.json)
- 阶段 5 机器边界：[stage5-contract.json](./stage5-contract.json)
- 阶段 6 机器边界：[stage6-contract.json](./stage6-contract.json)
- 阶段 7 机器边界：[stage7-contract.json](./stage7-contract.json)
- 阶段 8 机器边界：[stage8-contract.json](./stage8-contract.json)
- 阶段 9 机器边界：[stage9-contract.json](./stage9-contract.json)
- 阶段 10 机器边界：[stage10-contract.json](./stage10-contract.json)
- 阶段 11 机器边界：[stage11-contract.json](./stage11-contract.json)
- 阶段 12 机器边界：[stage12-contract.json](./stage12-contract.json)
- 阶段 13 机器边界：[stage13-contract.json](./stage13-contract.json)
- 阶段 14 机器边界：[stage14-contract.json](./stage14-contract.json)
- 架构决策：[ADR 0050](../docs/for-ai/adr/0050-typed-shader-ir-and-authoring-frontends.md)、[ADR 0052](../docs/for-ai/adr/0052-precompiled-shader-artifact-v2-and-layout-ownership.md)、[ADR 0053](../docs/for-ai/adr/0053-builtin-postprocess-module-family-and-production-migration.md)、[ADR 0054](../docs/for-ai/adr/0054-2d-ui-simple3d-shader-module-family-migration.md)、[ADR 0055](../docs/for-ai/adr/0055-atomic-production-deformation-pass-family.md)、[ADR 0056](../docs/for-ai/adr/0056-atomic-production-material-lighting-family.md)、[ADR 0057](../docs/for-ai/adr/0057-specialized-rendering-family-and-fixed-texture-utilities.md)、[ADR 0058](../docs/for-ai/adr/0058-typed-compute-effects-and-production-family.md)、[ADR 0059](../docs/for-ai/adr/0059-glsl-es300-backend-feasibility-boundary.md)

## 建议阅读顺序

1. [architecture.md](./architecture.md)：系统边界、编译流水线和迁移原则。
2. [type-system-and-stages.md](./type-system-and-stages.md)：类型、stage、坐标空间和 varying 规则。
3. [material-surface.md](./material-surface.md)：材质语义槽位与多 pass 一致性。
4. [resource-abi.md](./resource-abi.md)：符号资源、绑定空间和 reflection。
5. [variants-and-capabilities.md](./variants-and-capabilities.md)：静态变体、动态参数和目标 profile。
6. [graph-format.md](./graph-format.md)：节点图 v1、规范化和迁移。
7. [escape-hatches.md](./escape-hatches.md)：受信任扩展与原始 shader 边界。
8. [pilots.md](./pilots.md)：三个迁移试点及 go/no-go 门禁。
9. [stage1.md](./stage1.md)：当前可执行实现、限制和验证。
10. [stage2.md](./stage2.md)：Typed IR、TypeScript builder、WGSL backend 和真实 WebGPU smoke。
11. [stage3.md](./stage3.md)：Graph v1、MaterialSurface、PBR/Fog lowering 和手写参考像素/gzip gate。
12. [stage4.md](./stage4.md)：Typed IR deformation region、自动 vertex/varying、五 pass 与真实 glTF gate。
13. [stage5.md](./stage5.md)：Postprocess Typed IR、外部 pass plan、稳定 motion blur reconstruction 与像素 gate。
14. [stage6.md](./stage6.md)：构建期 artifact、runtime reflection adapter 与 Motion Blur 生产迁移。
15. [stage7.md](./stage7.md)：Artifact V2、多 group/layout owner、生成注册表和迁移清单。
16. [stage8.md](./stage8.md)：builtin postprocess module-family、九 pass 生产迁移和真实 WebGPU gate。
17. [stage9.md](./stage9.md)：2D/UI 与 simple-3D module-family、17 pass 生产迁移和 bundle/WebGPU gate。
18. [stage10.md](./stage10.md)：production deformation family、morph/skinning/history ABI 与角色辅助 pass 闭环。
19. [stage11.md](./stage11.md)：production material-lighting family、PBR 变体、Blinn/Toon 与 Fog/light ABI 闭环。
20. [stage12.md](./stage12.md)：production specialized-rendering family、固定纹理 utility 与 renderer/artifact layout ownership。
21. [stage13.md](./stage13.md)：Typed Compute IR、副作用/调度 ABI 与五个生产 compute pass 原子迁移。
22. [stage14.md](./stage14.md)：同一 Typed IR 的 GLSL ES 3.00 codegen、std140 reflection 与双后端浏览器证据。

## 机器可读契约

- [stage0-contract.json](./stage0-contract.json)：冻结的阶段 0 决策摘要，供结构门禁消费。
- [stage1-contract.json](./stage1-contract.json)：阶段 1 实现范围和明确延期项。
- [stage2-contract.json](./stage2-contract.json)：阶段 2 实现范围、PBR foundation 边界和延期项。
- [stage3-contract.json](./stage3-contract.json)：阶段 3 Graph/MaterialSurface/PBR Pilot 1 证据与延期项。
- [stage4-contract.json](./stage4-contract.json)：阶段 4 自动 vertex/varying 与多 pass deformation Pilot 2 证据。
- [stage5-contract.json](./stage5-contract.json)：阶段 5 postprocess Typed IR 与 motion blur Pilot 3 证据。
- [stage6-contract.json](./stage6-contract.json)：阶段 6 构建期 artifact、runtime adapter 与首个生产迁移证据。
- [stage7-contract.json](./stage7-contract.json)：阶段 7 Artifact V2、layout ownership、cache 和迁移治理证据。
- [stage8-contract.json](./stage8-contract.json)：阶段 8 builtin postprocess family、生产迁移和浏览器证据。
- [stage9-contract.json](./stage9-contract.json)：阶段 9 2D/UI 与 simple-3D family、bundle 和浏览器证据。
- [stage10-contract.json](./stage10-contract.json)：阶段 10 production deformation family、ABI 和浏览器证据。
- [stage11-contract.json](./stage11-contract.json)：阶段 11 production material-lighting family、ABI、bundle 和浏览器证据。
- [stage12-contract.json](./stage12-contract.json)：阶段 12 production specialized-rendering family、ABI、bundle 和浏览器证据。
- [stage13-contract.json](./stage13-contract.json)：阶段 13 production compute family、副作用/调度 ABI、bundle 和浏览器证据。
- [stage14-contract.json](./stage14-contract.json)：阶段 14 GLSL ES 3.00 feasibility、明确拒绝路径与双后端像素证据。
- [graph-v1.schema.json](./graph-v1.schema.json)：节点图 v1 JSON Schema。
- [pilot-pbr-composition.graph.json](./pilot-pbr-composition.graph.json)：PBR 组合试点的规范 fixture，不是已生成 shader 的性能证据。
- [pilot-motion-blur-postprocess.graph.json](./pilot-motion-blur-postprocess.graph.json)：Motion blur postprocess 的规范 graph fixture。
- [reflection-v1.schema.json](./reflection-v1.schema.json)：编译产物 reflection v1 JSON Schema。
- [precompiled-artifact-v2.schema.json](./precompiled-artifact-v2.schema.json)：构建期到 engine 私有 runtime 的 Artifact V2 JSON Schema。
- [builtin-postprocess-family.schema.json](./builtin-postprocess-family.schema.json)：内置后处理 module-family v1 JSON Schema。
- [builtin-postprocess-family.json](./builtin-postprocess-family.json)：阶段 8 九个 compiler-owned 标准库 operation 的规范输入。
- [builtin-render-family.schema.json](./builtin-render-family.schema.json)：阶段 9 renderer module-family v1 JSON Schema。
- [builtin-engine-2d-ui-family.json](./builtin-engine-2d-ui-family.json)、[builtin-components-2d-ui-family.json](./builtin-components-2d-ui-family.json)、[builtin-simple-3d-family.json](./builtin-simple-3d-family.json)：阶段 9 三个 delivery slice 输入。
- [builtin-deformation-family.schema.json](./builtin-deformation-family.schema.json)、[builtin-deformation-family.json](./builtin-deformation-family.json)：阶段 10 原子 deformation family 输入。
- [builtin-material-lighting-family.schema.json](./builtin-material-lighting-family.schema.json)、[builtin-material-lighting-family.json](./builtin-material-lighting-family.json)：阶段 11 material-lighting family 输入。
- [builtin-specialized-rendering-family.schema.json](./builtin-specialized-rendering-family.schema.json)、[builtin-specialized-rendering-family.json](./builtin-specialized-rendering-family.json)：阶段 12 specialized-rendering family 输入。
- [builtin-compute-family.schema.json](./builtin-compute-family.schema.json)、[builtin-compute-family.json](./builtin-compute-family.json)：阶段 13 compute side-effect/dispatch IR 输入。
- [migration-manifest.json](./migration-manifest.json)：全部 WGSL、内联 shader site 与 escape hatch 的迁移状态。

运行：

```bash
npm run shader-language:check
```

该门禁先检查阶段 0 文件、固定枚举、逻辑资源空间、Artifact/module-family schema、迁移清单和仓库索引，再执行阶段 1–14 typecheck、构建、契约测试、private compiler/runtime 边界与统一 production artifact stale check。真实 Chrome 验证使用阶段 2–14 的独立命令；阶段 14 运行 `npm run verify:shader-language-stage14`。后续编译器实现不能通过修改统计口径绕过这些契约；需要改变决策时应新增 ADR并提升对应格式版本。

## 阶段 14 仍未包含

- 不实现 arbitrary deformation node plugin、text parser、完整优化器或 shader graph UI。
- 不由 shader compiler 创建纹理、调度 RenderGraph 或管理 GPU resource lifecycle。
- 不替换现有 `WgslFeatureComposer`。
- 不增加 stable/experimental export。
- 不承诺 WebGL2 renderer fallback。
- 不把现有 production family 自动宣称为 WebGL2-compatible；cross-stage varying/MRT 与 renderer feature degradation 尚未完成。
- 不允许场景或 graph JSON 携带任意 WGSL、GLSL、JavaScript 源码。
