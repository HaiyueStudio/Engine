# E_COMPUTE_INVALID_PARAMETER

Compute 参数不满足管线约束。根据错误 path 检查尺寸、格式、usage、dispatch 范围和设备 capability。

所有结构化错误都包含 domain、code、recoverable、recovery、context、path 和可选 cause；诊断时保留完整对象，不要只记录 message。
