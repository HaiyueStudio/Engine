# E_COMPONENT_SCRIPT_FAILED

单个项目脚本在编译或 lifecycle 执行时抛出异常。

错误 `context` 包含 `scriptResourceId/name`、`entityId/name`、`componentId`、`lifecycle`、`source`、`line` 和 `column`，`path` 指向具体资源 lifecycle。默认策略会禁用该 `ScriptComponent`，其他脚本和帧循环继续运行。

修复源码后调用 `ScriptResource.setScript()` 会触发热重载；也可以在修复运行时状态后调用组件的 `restart()`。不要通过 `continue` 长期忽略重复错误。

