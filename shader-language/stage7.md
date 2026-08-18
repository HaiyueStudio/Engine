# 阶段 7：通用 Artifact V2 与 Runtime ABI

阶段 7 把阶段 6 的 Motion Blur 单 group 交付切片扩展为可承载后续 renderer 的通用私有 ABI。本阶段没有迁移新的 production shader，PBR、deformation、2D/UI、后处理和 compute 仍按独立阶段推进；`@haiyue/shader-language` 继续是 private workspace，也没有修改 engine 公共 API。

## Artifact V2

构建期交付格式升级为 [precompiled-artifact-v2.schema.json](./precompiled-artifact-v2.schema.json)。每个 pass 明确携带：

- render 或 compute entry point；
- 完整、连续的 physical bind group；
- 每个 group 的 logical space/group 与 physical group；
- `artifact` 或 `renderer` layout owner；
- buffer、sampler、texture、storage texture、external texture 的完整 layout；
- uniform byte layout、vertex buffer、varying、render target class、capability、pass requirement 和 source map。

逻辑资源空间仍固定为 frame 0、object 1、material 2、pass 3。physical group 可以由 renderer 适配，但映射同时进入源码、reflection 和 canonical artifact hash，禁止在生成后替换 WGSL 文本。V1 Motion Blur artifact 继续由 runtime 读取；新生成器必须使用 V2，除非兼容性测试明确要求生成 V1 fixture。

## Runtime layout ownership

`PrecompiledShaderRuntime` 现在接受多个 group。artifact-owned group 由 adapter 从 reflection 创建；SceneFrame、RendererObjectTable、material arena 等已有 renderer ABI 通过 `rendererOwnedLayouts` 显式注入。缺少外部 layout 会在创建 shader module/layout 前抛错，不创建半成品 GPU 资源。

cache 被拆成三个层次：

1. shader module：`device + artifactHash + passHash`；
2. artifact-owned bind-group layout：再加 physical group；
3. pipeline layout/runtime：再加所有 renderer-owned layout 的对象身份。

因此相同 renderer layout 完整命中；切换外部 layout 时只创建新的 pipeline layout，不重复创建 shader module 或 artifact-owned layout，也不会把两个不兼容的 layout 错误归入同一个 cache key。

engine 为测试构建 `dist/internal/precompiled-shader-runtime.js` 私有入口，但 package exports 不暴露该路径；production bundle 仍通过 MotionBlur 等内部引用消费 runtime，engine 也不依赖 compiler package。

## 生成注册表和迁移清单

`npm run shader-language:generate` 和 stale check 统一经过 [generate-production-shaders.mjs](./scripts/generate-production-shaders.mjs)。阶段 6 的 Motion Blur generator 已登记为首个 registry entry，历史专属命令保留用于 V1 兼容验证。

[migration-manifest.json](./migration-manifest.json) 对当前 57 个 WGSL 文件逐一分类：

- 3 个 Motion Blur generated source；
- 54 个待迁移或明确保留的手写 WGSL；
- 3 个内联 engine shader site；
- 4 个 escape hatch/过渡设施。

清单与实际目录做集合相等检查。新增、删除或移动 WGSL 而未更新评审状态会令 fast gate 失败。CustomPass 和 ComputeKernel 保留 raw-WGSL 输入边界；它们不是内置 shader 迁移缺口。

## 验证

`npm run verify:shader-language-stage7` 保留阶段 6 的 Motion Blur production 像素门禁，并新增真实 Chrome/WebGPU 多 group fixture。fixture 同时绑定 renderer-owned frame group 和 artifact-owned material group，验证：

- 中心像素为 `51,153,204,255`，最大通道误差不超过 1；
- compilation、validation、unclassified failure 均为 0；
- 同一 external layout 只创建 1 个 module、1 个 artifact layout 和 1 个 pipeline layout；
- 更换 external layout 后 module/layout 计数仍为 1，pipeline layout 增至 2。

Node 门禁同时覆盖单 group postprocess V2 fixture、完整 binding descriptor、V1/V2 runtime 兼容、missing owner 失败事务和 uniform reflection writer。

## 后续边界

阶段 8 可以开始迁移简单 fullscreen postprocess；2D/UI 与 compute IR 基础可以并行准备。deformation 必须作为 forward/depth/shadow/motion/outline 的同一 pass family 迁移，PBR 必须等待 deformation 与 renderer-owned 多 group ABI 共同稳定。阶段 7 不更新 API baseline，也不借内部测试入口提前发布 shader API。

机器范围见 [stage7-contract.json](./stage7-contract.json)，长期决策见 [ADR 0052](../docs/for-ai/adr/0052-precompiled-shader-artifact-v2-and-layout-ownership.md)。
