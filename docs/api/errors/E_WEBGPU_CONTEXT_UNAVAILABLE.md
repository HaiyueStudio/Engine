# E_WEBGPU_CONTEXT_UNAVAILABLE

Adapter/device 已取得，但 Canvas 目标无法解析，或者 Canvas 无法取得、配置 WebGPU context。确认 `options.canvas` 是 `HTMLCanvasElement`、裸 Canvas 元素 ID，或能命中 `<canvas>` 的有效 CSS 选择器，并确认浏览器允许 WebGPU。通过 `HaiyueEngine.webGpuCompatibility` 展示统一的阻塞兼容页面，不要回退到 WebGL。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
