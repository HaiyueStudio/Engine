# E_INPUT_PROFILE_INVALID

输入 profile 的选项、格式、版本、动作／绑定、容量或样本无效，或 profile 已销毁。保存格式为 `haiyue-input-profile`、版本 1；恢复使用原动作映射完成完整校验后提交，失败不覆盖旧绑定。

默认最多 256 个动作，可显式设置 1–4096。捕获阈值默认 0.5，须大于固定回中阈值 0.15 且不超过 1。profile 不监听设备、不轮询、不管理存储；调用方提供原宿主样本，并通过已有保存服务存取 `exportData()`。

销毁后 `offer`、恢复及导出会报告此错误。`dispose()` 和 `cancelRebind()` 可重复调用。`onChange` 在提交后通知；观察回调的异常不回滚已经生效的绑定。
