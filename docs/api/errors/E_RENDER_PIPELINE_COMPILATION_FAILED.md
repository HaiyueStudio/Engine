# E_RENDER_PIPELINE_COMPILATION_FAILED

WebGPU render 或 renderer-owned compute pipeline 在异步预热或同步后备创建时编译失败。render pipeline 检查 `context.renderer`，compute pipeline 检查 `context.owner`；两者都应检查 `context.key`、`context.label` 与原始 `cause`，并结合 Shader Feature Composer 的 WGSL source mapping 定位具体模块。

该错误的 recovery 为 `retry`。修正 shader、feature 组合或 pipeline descriptor 后，可以重新创建场景或 renderer 并执行新的 `PipelineWarmupPlan`；同一个已失败 plan 不会重复运行。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
