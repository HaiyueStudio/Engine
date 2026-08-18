# ADR 0010：Scene、插件注册与渲染协调边界

- 状态：Accepted
- 日期：2026-07-13

## 背景

阶段四固定生命周期和资源 ownership 后，`Scene` 仍同时负责 World 状态、默认相机与系统、资产任务、插件上下文和 preset 分支；`RenderPipeline` 同时负责 pass 调度与 system GPU owner；插件注册 API 只产生 `void` 副作用。继续在这些协调对象上叠加能力会使新 preset、资产策略和插件注册相互牵连。

海月是 3D 优先的新引擎，不保留旧内部结构或旧插件注册返回值兼容层。

## 决策

1. `Scene` 保留用户 facade，内部组合五个职责服务：
   - `SceneRuntime`：World、状态转换、update 和 scene GPU scope；
   - `SceneSystems`：相机、system 安装顺序和 render registration；
   - `SceneAssets`：AbortSignal、asset handle、提交检查和释放；
   - `ScenePlugins`：scene registry、插件 context 和依赖生命周期；
   - `ScenePresetFactory`：声明式 3D/2D/GUI/mixed 配置与 system plan。
2. 内部服务依赖最小 contract，不得导入具体 `Scene` facade。插件看到的 scene 类型改为结构化 `ScenePluginScene`。
3. `PluginRollbackScope.track()` 以及 engine/scene/editor 插件上下文的所有注册方法返回 `RegistrationToken`。token 暴露 `active`，`unregister()` 幂等；插件事务仍按逆序统一回滚未手动撤销的 token。
4. `RenderPipeline` 只保存 entry 排序、record mode、target 与 pass sharing contract。GPU owner 移到 `RenderSystemResourceOwnership`，由 `RenderIntegration` 通过通用 `RenderPipelineExecutionBoundary` 注入。
5. 新增 `RenderProfile` 与只读 `RenderCapabilities`。默认使用 `haiyue-3d-default`，声明 timestamp、indirect-first-instance 和压缩纹理为可选 device intent；本阶段不新增渲染特性。
6. 包内门禁解析 TypeScript runtime value-import 图，禁止运行时循环；类型互引由 strict TypeScript 检查。Scene internal 反向依赖 facade、core 反向依赖 Scene 和 Pipeline 引入具体业务模块均为错误。

## 后果

- 新 preset 只增加数据定义；新资产 policy 或插件 registration 可以在对应服务内演进。
- 插件可在安装事务结束前单独撤销某项注册，host remove/failure rollback 不会重复清理。
- Pipeline 测试只依赖公开 pass/execution boundary，不需要 renderer、GPU cache 或 owner 私有实现。
- `RenderProfile` 是后续高级渲染配置的唯一结构入口；普通 scene preset 与 GPU capability 不再混为同一层概念。
- 为清除 runtime import cycle，ECS/Frame 中仅用于类型的依赖改为 type-only import，不改变运行时 API。

## 自动约束

- `npm run modules:check`
- `npm run architecture:check`
- `engine/test/architecture-stage5.test.mjs`
- `engine/test/render-pipeline.test.mjs`
- `editor/test/runtime-export.test.mjs`
- `npm run check:fast`

