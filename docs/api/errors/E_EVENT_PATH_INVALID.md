# E_EVENT_PATH_INVALID

事件传播路径包含空项，无法继续 capture 或 bubble。根据 `path` 和 `context.phase` 定位无效项，移除空项，并确保目标 `EventEmitter` 是路径中的最后一项。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
