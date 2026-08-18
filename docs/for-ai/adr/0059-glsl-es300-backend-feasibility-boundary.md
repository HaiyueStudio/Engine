# ADR 0059：GLSL ES 3.00 后端只验证 Typed IR 可移植性

- 状态：Accepted
- 日期：2026-07-29
- 影响：shader backend、资源 reflection、多后端规划与 WebGPU-only 产品边界

## 背景

阶段 2–13 已建立 canonical Typed IR、WGSL backend、Artifact V2，并把主要 production WGSL family 迁移到构建期产物。ADR 0050 把 GLSL ES 3.00 定义为可行性目标，但尚未证明同一 IR 可以生成可编译、可绑定且数值一致的 GLSL。若直接开始 WebGL2 renderer，shader 语义、renderer capability degradation 与资源生命周期会混在同一变更中，无法判断失败属于哪一层。

## 决策

1. 阶段 14 新增 private GLSL ES 3.00 backend，输入必须是 canonical Typed IR，禁止把 WGSL 源码文本作为转译输入。
2. backend 生成完整且确定性的 vertex/fragment stage source、backend hash、source map 和目标资源 reflection。现有 Composer 继续只组合 WGSL module，不假装支持 GLSL target。
3. WGSL 分离 texture/sampler 在实际 sample pair 处 lower 为 compiler-owned combined `sampler2D`，reflection 固定 texture unit。一个 texture 以不同 sampler 采样时产生不同 pair。
4. uniform block 使用独立 std140 layout reflection；不得复用 WGSL host layout。offset、size、block alignment 和 matrix stride 均由 GLSL backend 拥有。
5. compute、storage resource、opaque uniform WGSL type、无法表达的纹理/采样器类型和超限资源必须以 `E_SHADER_TARGET_UNSUPPORTED` 精确失败，禁止静默删除能力或同步 fallback。
6. 真实浏览器证据必须从同一 IR 分别运行 WebGPU/WGSL 与 WebGL2/GLSL，覆盖 compile/link、UBO、texture/sampler 和像素一致性，而不只做字符串 snapshot。
7. 本阶段不修改 engine、editor、player 或 export runtime。ADR 0044 的 WebGPU-only 产品契约保持不变；WebGL2 renderer fallback 必须另立阶段，处理 RenderGraph、resource owner、format、compute/indirect 和 feature degradation。

## 结果

- Typed IR 的可移植表达式和资源子集获得真实双后端证据。
- std140 与 WGSL layout 差异成为显式 reflection，不会在 runtime 隐性错包数据。
- GLSL codegen 能独立演进，但不能被当作已经支持 WebGL2 产品交付。
- cross-stage varying linker、MRT 和 production family 跨后端 lower 仍需在扩大 renderer 范围前补齐。
