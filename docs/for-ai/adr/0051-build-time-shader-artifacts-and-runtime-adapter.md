# ADR 0051：内置 Shader 使用构建期产物与私有 Runtime Adapter

- 状态：Accepted
- 日期：2026-07-28

## 背景

ADR 0050 确立 Typed Shader IR 为唯一 authoring 规范。PBR、deformation 和 motion blur 三个试点已分别通过，但 production engine 不能在每次启动或每帧加载 private compiler，也不能同时长期维护手写 WGSL 与生成 WGSL 两套事实来源。

现有生产 postprocess 使用紧凑的 group 0，而规范逻辑资源空间把 `pass` 固定为 group 3。直接对生成源码做字符串替换会绕过 canonical codegen、reflection 和诊断，不能作为迁移方法。

## 决策

1. 内置 shader 在构建期从 graph/Typed IR 生成，engine 只消费确定性的、可登记 provenance 的预编译产物。
2. private compiler 不成为 `@haiyue/engine` 的运行时或 package dependency。生成 WGSL 和 manifest 可以提交到 engine source，但必须由 stale gate 保证与 compiler/graph 一致。
3. logical resource group 到 renderer physical group 的映射是 codegen option；WGSL 和 reflection 同时生成目标 group，禁止对源码执行正则或字符串替换。
4. engine 的私有 runtime adapter 根据 manifest reflection 创建 bind-group layout、pipeline layout 和 uniform writer。它不解析 graph、不生成源码、不创建 render pass。
5. immutable shader module/layout 按 `GPUDevice + artifactHash + passHash` 复用；uniform buffer、sized texture 和 bind group 仍由具体 renderer instance 管理和销毁。
6. 一个生产切片完成迁移后删除被替代的手写 shader。生成器失败、产物过期或 shader 编译失败必须显式阻断，不静默回退到可能已漂移的旧实现。
7. 首个迁移切片只包含已具备 exact pixel parity 的 Motion Blur tile-max、neighbor-max 和 resolve。PBR 与 deformation 需要独立评审，不能借本 ADR 自动迁移。
8. 本决策不增加公共 shader API，不改变现有 `MotionBlurPass` API，也不更新 API baseline。

## 后果

- production bundle 不携带 compiler、graph parser 或 node registry，运行时 shader generation 为 0。
- checked-in artifact 增加少量生成文件，但任意手工修改或 graph/compiler 漂移都会被 fast gate 拒绝。
- runtime layout 与 uniform byte offset 不再在 `MotionBlurPass` 中手工复制。
- 同设备多个 MotionBlurPass 只创建三份 shader module/layout，instance-owned GPU resource 生命周期保持独立。
- GLSL ES 300、WebGL2 renderer、可视化 graph editor 和用户 graph runtime cache 仍不在本决策范围内。

阶段范围与证据见 [shader-language/stage6.md](../../../shader-language/stage6.md)。
