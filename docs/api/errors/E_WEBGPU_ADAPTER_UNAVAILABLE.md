# E_WEBGPU_ADAPTER_UNAVAILABLE

浏览器暴露 WebGPU，但 `requestAdapter()` 没有返回可用 adapter。检查硬件加速、系统 GPU/驱动、浏览器策略与远程桌面环境，并通过 `HaiyueEngine.webGpuCompatibility` 展示统一的阻塞兼容页面。不要回退到 WebGL。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
