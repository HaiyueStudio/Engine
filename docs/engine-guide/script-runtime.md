# 项目脚本运行时

海月项目脚本是受信任项目代码，不是安全沙箱。`ScriptComponent.enableTrustedProject()` 会在页面 JavaScript realm 中执行脚本，脚本理论上仍能访问该 realm 的全局对象。capability 只约束推荐且受支持的引擎 API。

## Capability API

- `api.read`：数据、实体/组件查询、只读 canvas/engine/global 信息。
- `api.scene`：创建/销毁实体、生成 prefab、添加组件/系统、修改场景文本。
- `api.asset`：prefab/资产查询与受控加载。
- `api.input`：输入 action 与键盘状态。
- `api.physics`：物理查询和受控 mutation。
- `api.debug`：带脚本上下文的 console，以及自动清理的 listener/timer/disposer。

默认只开启 `read`、`input`、`debug`。运行时应显式声明，例如：

```ts
ScriptComponent.enableTrustedProject({
  capabilities: ['read', 'scene', 'asset', 'input', 'physics', 'debug'],
  errorPolicy: 'disable-script',
});
```

旧的扁平 `api.world/api.data/api.console` 和 `enableTrustedEval` 已删除，不保留兼容层。

## 热重载

监听和定时器必须通过 `api.debug.listen/setTimeout/setInterval` 注册，自定义资源通过 `api.debug.addDisposer` 登记。`ScriptResource.setScript()` 会通知所有引用组件；组件先 dispose 旧 `ScriptExecutionScope`，再清除编译缓存。组件移除、world 移除和 destroy 使用同一清理路径。

## 错误和调试

脚本异常不会冒泡到 World 帧循环。默认 `disable-script` 只禁用故障 `ScriptComponent`；`pause-script` 可暂停该组件，`continue` 适合诊断。`restart()` 清除 fault/pause 并重新编译。

`ScriptRuntimeErrorEvent` 包含 resource、entity、component、lifecycle、`haiyue-script://` source URL、行列与原始 cause。`sourceMap` resolver 可把生成位置映射回项目源码。编辑器 player 将结构化错误发送到输出面板。

导出项目包含 `src/haiyue-script-runtime.d.ts`。它和编辑器提示都由引擎的 `SCRIPT_RUNTIME_CONTRACT` 生成；声明生成器接收实际启用的 capability，只把可用分组声明为必选字段，避免声明与运行时不一致。
