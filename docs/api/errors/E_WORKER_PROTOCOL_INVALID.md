# E_WORKER_PROTOCOL_INVALID

Worker 能力不可用、消息无法结构化克隆、请求或响应不符合协议，或者 Worker 执行异常。先根据 `path` 区分 capability、postMessage、response、error 与 messageerror，再检查页面 `worker-src` CSP、module Worker URL、transferable 生命周期和 payload 的有限数值。

该错误不会静默回退到主线程同步计算。`recovery` 为 `terminate-runtime` 时应释放对应 client/pool slot；若仍需继续工作，在能力或输入修正后创建新的 Worker client。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
