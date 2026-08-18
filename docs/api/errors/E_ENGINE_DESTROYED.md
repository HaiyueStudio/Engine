# E_ENGINE_DESTROYED

对象所属 Engine 已销毁。不要复用 scene、asset handle 或 renderer；创建新的 Engine 生命周期。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
