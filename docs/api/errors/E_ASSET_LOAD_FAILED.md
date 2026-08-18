# E_ASSET_LOAD_FAILED

资产加载失败。检查 URL、CORS、MIME、worker 协议和取消信号；失败的 AssetJob 应释放已取得 handle，并按错误 recovery 字段重试或释放。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
