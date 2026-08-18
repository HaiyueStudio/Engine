# 阶段 14：Typed IR 的 GLSL ES 3.00 后端可行性

阶段 14 用同一份 canonical Typed Expression IR 直接生成 WGSL 与完整的 GLSL ES 3.00 vertex/fragment stage source，证明多后端边界不依赖 WGSL 文本翻译。GLSL backend 输出确定性 hash、entry source map、std140 uniform block reflection，以及由 WGSL 分离 texture/sampler 对映射得到的 compiler-owned `sampler2D`/texture-unit reflection。

可移植性必须显式：compute、storage buffer/storage texture、opaque WGSL uniform type、非 `texture_2d<f32>` 和超出资源上限均返回 `E_SHADER_TARGET_UNSUPPORTED`，不生成缩水 shader，也不静默切回别的路径。WebGPU uniform layout 与 std140 分开计算；例如 `mat2` 在 std140 中使用 16-byte column stride，不能复用 WGSL host layout。

真实 Chrome fixture 从一份 IR 生成两种目标源码，分别在 WebGPU/WGSL 与 WebGL2/GLSL ES 3.00 中完成 shader compile、pipeline/program link、UBO、texture/sampler 绑定和像素读回。当前证据为两边像素 `[44,8,4,255]`，cross-backend delta 为零，WebGPU validation、WebGL compile/link 与未分类失败均为零。

## 边界

- 这是 private compiler codegen feasibility，不是 WebGL2 renderer。
- engine、editor、player、导出 runtime 继续遵守 WebGPU-only 产品契约。
- 不把 `composeShaderModules()` 伪装成 WGSL-to-GLSL 转译器；GLSL backend 只接受 Typed IR。
- 不迁移 production shader family，不更新 engine API baseline。
- cross-stage varying linker、MRT、production family 跨后端 lower、WebGL2 资源/RenderGraph/feature degradation 留待后续阶段。

机器边界与浏览器证据见 [stage14-contract.json](./stage14-contract.json)，架构决定见 [ADR 0059](../docs/for-ai/adr/0059-glsl-es300-backend-feasibility-boundary.md)。
