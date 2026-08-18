# ADR 0015：Scene 普通用户黄金路径与帧阶段契约

- Status: Accepted
- Date: 2026-07-15

## Context

`HaiyueEngine` 已能自动更新 active scene，但仓库中的 getting started、普通 examples、game 和编辑器导出模板仍有两种运行方式：一部分执行 `createScene → switchScene → run`，另一部分监听 engine `update` 后手工调用 `scene.update()`。后者既可能与 active scene 自动更新叠加，也让切换、设备恢复和销毁的 owner 边界失去唯一入口。

动画通常要在 Scene systems 运行前修改状态，而输入收尾和诊断要在 Scene systems 运行后执行。单个无阶段定义的回调不能同时表达这两类需求。

## Decision

1. 普通用户唯一推荐生命周期为 `init → createScene → switchScene → run → switch/destroy`。`run()` 每帧只更新一次 active scene，调用方不得再手工驱动该 scene。
2. `update` 是 active scene 更新前的帧 hook，用于动画、控制器和状态写入；`after-update` 是 active scene 更新后的帧 hook，用于输入收尾、统计采样和首帧验证。
3. `switchScene()` 只接受当前 engine 创建且未进入销毁阶段的 Scene。失败切换是事务性的，不会停用或替换当前 active scene。
4. `switchScene(next, { destroyPrevious: true })` 是场景替换与释放路径；`engine.destroy()` 停止帧循环，销毁 active scene，并清除 engine listeners、资产与 GPU owner。
5. 明确拥有自定义 `World` 或特殊 compute/pass lifecycle 的底层示例可以在没有 active scene 时调用 `run()`；它们不构成第二套普通用户 API。
6. 不增加 application facade。仓库通过基于 TypeScript AST 的门禁验证高层 Scene 用法，产品行为由生命周期集成测试验证。

## Consequences

普通场景、game 和编辑器导出产物共享同一调用顺序，场景切换、device recovery 和销毁都围绕 active scene 工作。依赖原 `update` 发生在 Scene 之后的代码必须改用 `after-update`；依赖手工 `scene.update()` 的代码必须删除该调用并先 `switchScene()`。低层 World 示例继续承担显式调度责任，并在 example guide 中列出原因。
