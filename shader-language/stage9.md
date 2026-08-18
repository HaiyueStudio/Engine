# 阶段 9：2D/UI 与 simple-3D 生产迁移

阶段 9 把 2D/UI 和非 PBR 的 simple-3D shader 迁入 Shader Language 的 compiler-owned module family。17 个旧的 engine/components 手写 WGSL 入口已删除，构建期生成 17 个 checked-in WGSL 和三个 Artifact V2 delivery slice；compiler 继续是 private workspace，engine runtime 不解析 WGSL，也不携带 compiler。

## 两个 family、三个 delivery slice

阶段 9 只有两个架构 family：

- `2d-ui`：Animation2D、CanvasText2D、Spine2D、Tilemap2D、BitmapText、GUI image/shape/text、Mesh2D、Particle2D 和 RadialShadow；
- `simple-3d`：Basic、Basic skinned、MeshHelper、Normal、Particle3D 和 Sky。

2D/UI 按包边界拆成 engine 与 components 两个 delivery slice，所以仓库中有三个 family JSON。slice 只决定产物落点，不改变 operation、ABI 或编译规则。JSON 不携带 WGSL、binding 数字和 uniform offset；这些属于 [render-family standard library](./src/render-family/) 和 compiler reflection。

standard library 内的 WGSL 是受信任的 compiler implementation module，不是新的 raw-source frontend。场景、材质、graph JSON 与运行时 API 都不能向它注入源码。

## ABI 与生产切换

阶段 9 完整保留每个 renderer 现有的物理 group、binding、vertex location/stride、uniform 大小、blend/depth state 和 draw 调度。Artifact V2 中所有 group 的 owner 都是 `renderer`：

- engine 内 13 个 pass 通过内部 `getBuiltin2dUiShader()` / `getBuiltinSimple3dShader()` 交给通用 precompiled runtime，统一创建并缓存 shader module 与 pipeline layout；
- components 内 4 个 pass 直接导入同一编译器生成的 WGSL，避免 components 反向穿透 engine 私有 runtime，也不增加 package export；
- components 的 Artifact V2 仍作为私有构建入口进入浏览器门禁，证明生成代码与完整 reflection 可以共同创建真实 WebGPU pipeline。

Basic skinned 仍保持当前 morph-then-skin、group 3 skin buffers 和单独 pipeline。阶段 9 不提前重构 deformation pass family；compiler standard library 中的 scene-frame/fog/morph/skinning module 与尚未迁移的 legacy feature source 暂时并存，阶段 10 再统一 forward/depth/shadow/motion/outline 的 deformation 来源。

## Bundle 边界

engine 两个私有 artifact entry 在 production Rollup 输出中的 level-9 gzip 合计为 11,460 bytes，阶段 9 上限为 12,000 bytes。components 的公共 animation/spine/tilemap/canvas-text entry 直接引用各自 WGSL，不加载 2,071-byte gzip 的 reflection evidence entry。engine/components bundle 中不得出现 `compileBuiltinRenderFamilyV1` 或 family parser。

这项预算只约束阶段 9 新增的 artifact/reflection delivery 成本，不把原有 shader code 体积伪装成新增成本。后续若 reflection 继续增长，应先提供按 pass 切片或更紧凑的只读编码，再提升预算。

## 证据

`npm run verify:shader-language-stage9` 保留阶段 2–8 的全部既有证据，并在真实 Chrome/WebGPU 中：

- 编译 3 个 delivery slice 的 17 个 generated pass；
- 从 reflection 创建 45 个 renderer-owned bind-group layout 与 17 个 pipeline layout；
- 要求 compilation、validation 与 unclassified failure 全为 0；
- 用 components 的真实 Tilemap2D generated shader 渲染固定颜色，读回中心像素 `32,191,64,255`，最大通道误差 1。

迁移后 engine/components 目录仍有 58 个 WGSL，其中 30 个 generated、28 个 handwritten；内联 shader site 和 raw escape hatch 数量没有变化。权威数字见 [stage9-contract.json](./stage9-contract.json)，长期决策见 [ADR 0054](../docs/for-ai/adr/0054-2d-ui-simple3d-shader-module-family-migration.md)。

## 后续边界

阶段 10 必须把 deformation 作为 forward/depth/shadow/motion/outline 一整个 pass family 迁移，不能逐文件制造不一致的 skin/morph/history ABI。PBR 继续等待 deformation family 稳定。阶段 9 不实现 GLSL ES 300、WebGL2 fallback、runtime user graph、可视化编辑器或稳定公开 Shader Language API。
