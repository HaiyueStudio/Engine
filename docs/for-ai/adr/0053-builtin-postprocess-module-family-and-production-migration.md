# ADR 0053：内置后处理采用 Module Family 与 Artifact V2 批量迁移

- Status: Accepted
- Date: 2026-07-28

## 背景

阶段 6 只迁移 Motion Blur，阶段 7 建立了可表达多 group 和 layout ownership 的 Artifact V2。Grayscale、Sobel、FXAA、Gaussian Blur、Outline、TAA 和最终 present 仍分别维护手写 WGSL、TypeScript bind-group layout 与 uniform offset；Outline 甚至会在 warmup/同步 fallback 构造 descriptor 时重复创建 module/layout。

逐个效果复制专属 compiler 会产生新的编排器，直接把旧 WGSL 当作 generator 输入则仍保留双事实来源。另一方面，这些算法包含循环、纹理邻域和时域重投影，不应为了“节点化”而强行污染通用 MaterialSurface IR。

## 决策

1. 建立版本化 `haiyue-builtin-postprocess-family`，输入只登记 compiler-owned 标准库 operation。
2. 标准库 operation 生成 WGSL 和完整 reflection；JSON 不允许携带 WGSL、binding 或 uniform offset。
3. family 一次生成九个 Artifact V2 pass，logical `pass` group 3 由 adapter 映射到 physical group 0。
4. 内置 production pass 只能通过私有 runtime adapter 获取 module/layout；删除对应手写 WGSL 和 present 内联源码。
5. RenderGraph 继续拥有 pass 调度、历史纹理和资源生命周期；shader compiler 不创建 GPU 对象。
6. `CustomPass` 保留 raw-WGSL 逃生口，但复用生成的 fullscreen vertex contract。
7. engine package 不公开 artifact/runtime 内部入口，不更新 API baseline。

## 结果

内置后处理的算法、reflection 与生成源码拥有单一构建期事实来源，stale gate 可以阻止提交产物漂移。TAA 的 unfilterable depth、双 render target 和 176-byte uniform block，以及 Outline 的三个不同 layout，均由 Artifact V2 明确表达。真实 WebGPU gate 会编译所有 pass 并使用 production GrayscalePass 做像素读回。

代价是 compiler 标准库仍需要维护各复杂算法的 backend emitter；它不是任意用户 graph。后续只有可复用且有明确语义/类型契约的计算才应提升为通用 IR node，不能把字符串宏重新包装成 DSL。
