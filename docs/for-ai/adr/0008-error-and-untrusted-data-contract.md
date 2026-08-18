# ADR 0008：统一错误与不可信数据边界

- 状态：Accepted
- 日期：2026-07-10

## 背景

引擎、组件、编辑器和 Worker 曾分别使用 `EngineError`、裸 `Error` 与字符串错误。调用方无法稳定判断失败属于哪个领域、能否恢复、应该重试还是终止运行时；Worker 还会丢失 code、path、context 和 cause。场景、glTF、Spine、localStorage 及 `postMessage` 数据也存在先断言类型、后进入领域模型的路径。

海月是全新引擎，没有旧错误格式和旧持久化格式的兼容义务。

## 决策

1. 跨包失败统一使用 `EngineError` 协议，固定提供：
   - `domain`：engine、asset、component、editor、worker、serialization 或 script。
   - `code` 与纯文本 `message`。
   - `recoverable` 与 `recovery`。
   - `context`、`path` 和可选 `cause`。
2. `recovery` 只有四种互斥语义：
   - `ignore`：输入可安全忽略，继续当前编辑/运行流程。
   - `retry`：外部条件变化后可重试同一操作。
   - `release-resource`：当前资源必须卸载，不继续使用部分结果。
   - `terminate-runtime`：当前 scene/runtime 或协议通道不再可信，必须终止。
3. Worker 只传输 `SerializedEngineError`。主线程必须先校验 response 与 error payload，再还原 `EngineError`；不接受字符串错误兼容分支。
4. 所有外部数据先以 `unknown` 接收并校验，再进入领域模型。错误 path 使用稳定的数据路径表达式，例如 `gltf.accessors[3]`、`entities[0].components[2].type`。
5. components 资产错误必须包含 URL、资源类型及可用的 accessor、bufferView、buffer 或 atlas path；editor 错误必须尽量包含 entity、component、field 和 resource id。
6. editor session 使用 `{ format: 'haiyue-editor-session', version: 1, data }` 信封。旧的无版本对象直接视为无效数据并恢复默认 session，不提供 fallback。
7. 公共声明不允许无约束 `any`。第三方动态格式只能在登记的 adapter 文件中保留显式 `any`，领域层只能接收已归一化类型。

## 自动约束

`npm run contracts:check` 检查：

- 根 `strict` 与 `useUnknownInCatchVariables`；
- engine/components 所有公开声明依赖图中的 `any`；
- 全仓未登记显式 `any`；
- 关键公共失败路径中的裸 `throw new Error` / `reject(new Error)`。

该检查进入 `check:fast`，并在 engine/components 构建声明后执行。

## 后果

- 错误展示、日志、Worker 和恢复调度可以共享同一协议。
- 无效内容会更早失败，但能定位到稳定 code/path，不再带着部分无效状态继续运行。
- 旧 editor session 会被丢弃，这是新项目阶段接受的破坏式格式调整。
- `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes` 已量化但不会与本阶段的错误协议混成一次超大改动；启用期限记录在阶段三验收基线中。
