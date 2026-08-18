# E_WEBGPU_UNSUPPORTED

当前 Runtime 没有 WebGPU 入口。使用 browser requirements 中的支持版本，并通过 `HaiyueEngine.webGpuCompatibility` 展示统一的阻塞兼容页面。海月是 WebGPU-only Runtime，不会尝试 WebGL fallback。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
