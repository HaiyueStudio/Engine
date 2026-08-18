# E_PLUGIN_LIFECYCLE_FAILED

插件 install/enable/disable/uninstall 生命周期失败。宿主已尽力回滚；检查 cause 并验证 token 清理。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
