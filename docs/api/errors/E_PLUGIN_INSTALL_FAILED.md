# E_PLUGIN_INSTALL_FAILED

插件安装失败并已回滚 registration token。检查依赖、插件版本与错误 cause，修复后重新安装。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
