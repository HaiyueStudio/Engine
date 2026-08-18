# 阶段 8：Builtin Postprocess 生产迁移

阶段 8 完成第一组 Artifact V2 真实批量迁移。`PostProcessRenderer.present`、Grayscale、Sobel、FXAA、Gaussian Blur、Outline 的 edge/blur/overlay 和 TAA 现在全部由 Shader Language 构建期生成；engine runtime 不解析 WGSL，也不携带 compiler。

## Module family

[builtin-postprocess-family.json](./builtin-postprocess-family.json) 是受版本控制的标准库 module-family 输入。它只声明九个稳定 operation，不包含 binding 数字、uniform offset 或 WGSL。`compileBuiltinPostprocessFamilyV1()` 负责：

- 校验 family identity、唯一 pass/operation 和来源 SHA-256；
- 从标准库 operation 派生 WGSL、完整 binding layout、uniform byte layout、capability、pass requirement 和 source map；
- 把逻辑 `pass` group 3 映射到 production physical group 0；
- 生成一个包含九个 pass 的 Artifact V2。

该 family 不是任意控制流 graph，也不是第二套通用 IR。复杂循环、TAA reprojection 和 FXAA 算法属于 compiler-owned 标准库 module；Graph/TS frontend 仍必须降到同一套 Typed IR 与资源规则，用户输入不能携带任意源码。

## Production cutover

统一生成器新增 `builtin-postprocess` entry，输出一个 checked-in artifact manifest、九个完整 pass WGSL 和一个 CustomPass 复用的 fullscreen vertex WGSL。被替换的九个 `engine/src/shaders/postprocess/*.wgsl` 已删除。

生产 pass 通过内部 `getBuiltinPostprocessShader()` 获取 module、bind-group layout 和 pipeline layout；Sobel、Gaussian Blur、Outline 与 TAA 的 CPU uniform packing 也改由 artifact reflection writer 驱动。Outline 不再在每次 pipeline descriptor 构造时重复创建 module/layout。RenderGraph 调度、纹理所有权、pass 次数、公共 PostProcess API 与 API baseline 均未改变。

`CustomPass` 和 `custom-pass-bindings.wgsl` 继续是明确的 raw-WGSL 逃生口；它的 fullscreen vertex contract 改为使用生成产物。这个边界不会被错误计作未迁移 builtin。

## 证据

`npm run verify:shader-language-stage8` 会保留阶段 2–7 的既有证据，并在真实 Chrome/WebGPU 中：

- 编译全部九个 generated production pass；
- 创建九套 reflection 驱动的 Artifact V2 layout；
- 通过真实 `GrayscalePass` 将固定输入读回为 `119,119,119,255`，最大通道误差 1；
- 要求 compilation、validation 和 unclassified failure 均为 0；
- 断言 production prepare 不绕过 runtime 再创建 shader module/layout。

当前迁移清单包含 58 个 WGSL：13 个 generated、45 个 handwritten；内联 shader site 从 3 个降到 2 个。正式数字见 [stage8-contract.json](./stage8-contract.json)，长期决策见 [ADR 0053](../docs/for-ai/adr/0053-builtin-postprocess-module-family-and-production-migration.md)。

## 后续边界

阶段 9 可以迁移 2D/UI 与 simple-3D，但必须分别控制变体、vertex ABI 和 bundle 成本。deformation 仍要按 forward/depth/shadow/motion/outline pass family 一次迁移，PBR 仍等待该 family 稳定。阶段 8 不实现 GLSL ES 300、WebGL2 renderer、运行时用户 graph、可视化编辑器或稳定公开 Shader Language API。
