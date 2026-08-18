# E_RENDER_COMMAND_CONTEXT_INVALID

渲染命令发生在错误的 pass/context 状态。检查 render/compute boundary、pass 是否已结束以及 target 契约。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
