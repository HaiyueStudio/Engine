# E_ENGINE_NOT_INITIALIZED

调用需要可用 GPUDevice，但 Engine 尚未完成 init。等待 `await engine.init()` 后再创建场景或 GPU 资源。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
