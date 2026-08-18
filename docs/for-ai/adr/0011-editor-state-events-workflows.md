# ADR 0011：编辑器状态、事件与核心工作流边界

- 状态：Accepted
- 日期：2026-07-13

## 背景

阶段五后，引擎协调层已拆分，但编辑器仍通过一个可变 `EditorStore` 暴露 session、runtime、inspector 和 resource selection 对象。UI 可以直接修改这些对象；事件携带整个 store；domain 内部读取 `globalThis.localStorage`；viewport engine 与 world 可分开替换；实体选择又由启动函数创建第二份状态。这些模式会让场景加载、资源导入、play session 和 undo/redo 出现半完成状态。

项目没有历史兼容要求，因此删除旧 store getter/setter 与可变字段，不提供兼容转发层。

## 决策

1. 编辑器状态按生命周期拆成六个服务：
   - `ProjectState`：global settings、active script、scene/resource revision；
   - `SessionState`：layout、recent files、device preview；
   - `RuntimeState`：唯一 engine/world/CommandBus/RuntimeOwnershipScope context；
   - `SelectionState`：entity active/set 与 resource selection；
   - `InspectorState`：context、selected component 和短期 commit snapshot；
   - `PlayState`：editing/playing/paused 有效状态转换。
2. `EditorStore` 只组合服务，对外提供不可变 `snapshot()`、`editorSelectors`、`commands` 和 typed subscribe。事件为最小 slice payload，不再携带 store。
3. Session persistence 使用 `EditorSessionPersistence` port；`LocalStorageEditorSessionPersistence` 位于 infra。domain 禁止 window、document、HTMLElement、CustomEvent 和 localStorage。
4. 删除 `getWorld/setWorld/getViewportEngine/setViewportEngine` 以及分离 runtime setter。Runtime 只能一次 attach 完整 context；clear 必须 release ownership scope。
5. `EditorStore.commands.transaction/transactionAsync` 统一批处理事件、CommandBus group、状态 snapshot 与失败 rollback。异步资源导入通过 transactionAsync 执行。
6. `CoreWorkflowCoordinator` 明确 scene、resource、entity、preview、export 五条工作流，统一 running/completed/cancelled/failed、AbortSignal 和 rollback contract。场景打开/保存、预览和导出已接入该协调器；资源/实体修改继续在 transaction/CommandBus 边界内完成。
7. 浏览器 player runtime 从 domain 移入 `engine-adapter/PlayerRuntimeAdapter`；engine experimental import 仍只能出现在 engine-adapter。
8. 编辑器插件注册继续由独立 extension registry/host 管理，不向 EditorStore 增加插件专用状态字段。

## 后果

- UI 获得的是 selector 结果与 command port，不能通过 store 引用修改内部集合。
- 实体、资源和 inspector selection 使用同一状态源。
- SessionState 可用内存 persistence 测试，不需要 DOM；RuntimeState 可用 mock owner 测试，不需要 GPU。
- play close 后可以通过 diagnostics 证明 listener、timer、scene reference 均为零。
- 新增可选编辑器能力只注册 extension，不改变根状态结构。

## 自动约束

- `npm run editor-architecture:check`
- `editor/test/editor-store.test.mjs`
- `editor/test/core-workflows-stage6.test.mjs`
- `editor/test/play-session-stage6.test.mjs`
- `npm test -w ./editor`
- `npm run check:fast`

