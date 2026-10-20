# 剧情 API

入口：`@haiyue/extensions/narrative`，可选稳定接口，不从根入口聚合。

## 数据

`NarrativeDefinition`：schemaVersion 1、id、version、start、variables、nodes。
节点 ID、变量名和动作名属于游戏；definition.version 是存档兼容版本，改动存档语义时必须更新。

| 节点 type | 核心字段 |
| --- | --- |
| dialogue | textKey、next，可选 speakerKey、artwork |
| choice | textKey、options，可选 speakerKey、artwork |
| branch | condition、then、otherwise |
| effect | effects、next |
| action | name、next，可选 payload、textKey |
| end | ending、textKey，可选 speakerKey、artwork |

artwork 为 `{assetKey, textKey}`。option 为 `{id, textKey, next, visibleWhen?, enabledWhen?, effects?}`。
条件：eq/ne/gt/gte/lt/lte（variable、value），all/any（conditions），not（condition）。
有序比较要求数值。效果：set 或 add，指定 variable/value，变量类型必须与初始声明一致。
作者应保证选择节点至少有一条可用路径；本版本不在选择界面上动态轮询外部库存。

## 执行

- `validateNarrativeDefinition(unknown)`：校验节点引用、条件、效果、重复选项和变量类型；复制并冻结有效字段。
- `new NarrativeRuntime(definition, {maxAutomaticSteps?})`：默认 256 步，允许 1..10000。
- `start(runId, initial?)`：新一轮剧情，runId 必须由宿主生成唯一值；initial 可覆盖已声明变量。当前运行的同一 runId 不可再次 start。
- `view`：未启动/销毁后为 null；其他情况返回冻结的 revision、nodeId、node、variables、可见 choices（含 enabled）、action、ending。
- `advance(expectedRevision?)`：推进 dialogue。过期 revision/节点类型不匹配返回 false。
- `choose(optionId, expectedRevision?)`：选择可见且可用选项。无效选择返回 false。
- `completeAction(requestId, result?)`：动作完成，result 是已声明变量的值。过期或重复确认返回 false。
- `save()`：返回 JSON 可序列化 `NarrativeSnapshot`，包含故事版本、runId、当前节点、变量、选择历史及待处理动作序号。
- `restore(unknown)`：严格检查版本与数据，恢复后重新发出 change，以及待处理 action/当前 end 事件。不会重新执行已经越过的 effect 节点。
- `subscribe(listener)`：返回取消函数，事件顺序为 change → action 或 change → end；dispose 独立通知。
- `dispose()`：幂等，清理订阅并通知适配器释放资源。

数据错误、自动步骤超限、非法变量值抛异常且不提交状态。观察者异常在提交后聚合抛出，
不得据此认为状态回滚。事件分发期间调用推进/恢复/销毁会报错，应延迟到事件分发结束。

## 动作连接器

`connectNarrativeActions(runtime, handlers, {signal?})` 返回 error、retry()、dispose()。
handlers 是动作名到函数的显式映射。函数接收 request 和 AbortSignal，返回变量结果或 Promise。
request 包含临时确认 id、持久 token、name、payload。读取其他剧情变量可使用 runtime.view。
未知动作/handler 失败使剧情停在 action，通过 error 读取并修复后 retry。
恢复/重新开始/销毁会取消旧请求；游戏必须取消自身的 UI、网络或音频等资源。

**幂等性由宿主共同完成。** 使用 token 把外部奖励和返回结果保存到同一可靠事务中。
恢复等待中的 action 会再次调用 handler，token 相同，不应重复产生副作用。
读取动作完成前的旧存档、崩溃或网络重试不能仅靠一个内存 Set 保证奖励不重复。

## GPU GUI

`new NarrativeGui(runtime, options)`，options 包含：

- parent：目标 GuiElement，例如 GuiRoot.root。
- i18n：I18n 实例；运行变量自动作为文案参数传入，布尔值转换为文字。
- continueKey、waitingKey：继续/等待提示的文案 key。
- imageLoader?：可使用 createI18nTextureLoader；缺失时展示图片对应的文字说明。
- bounds?、fontSize?、measureText?、signal?：布局、字宽度量及生命周期。

panel 是可布局的 GuiScrollView；ready 等待当前图片，imageError 返回图片错误。
refresh() 刷新呈现，dispose() 仅移除本组件和绑定，不销毁共享剧情、语言实例或无关 GUI。
文本按可用宽度分行，选择支持滚动；切换语言不会推进剧情，也不重跑动作。

[指南](../engine-guide/narrative.md) · [示例](../../examples/narrative/README.md) · [ADR](../for-ai/adr/0116-optional-narrative-runtime.md)
