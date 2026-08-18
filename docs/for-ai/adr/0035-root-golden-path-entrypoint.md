# ADR 0035：根稳定入口只保留 30 个黄金路径概念

- 状态：Accepted
- 日期：2026-07-22
- 影响：`@haiyue/engine` 默认入口、workspace imports、编辑器 runtime export、API surface gate
- 延续：[ADR 0023](./0023-stable-api-boundary-reset.md) 的 stable/experimental/internal 分层

## 背景

默认入口曾通过聚合 13 个领域 barrel 暴露 427 个符号。它让新用户无法判断推荐路径，也使任意领域增长自动扩大最常用入口；已有明确 stable subpath 却不能形成真正的模块边界。类型和 bundler 虽可 tree-shake，认知成本、自动补全噪声和错误 import 仍然存在。

## 决策

1. `@haiyue/engine` 只导出下列 30 个符号，按概念计数包含 value 与 type：
   - Engine/Scene：`HaiyueEngine`、`HaiyueEngineOptions`、`Scene`、`SceneOptions`、`RenderProfileName`；
   - ECS/Error：`Component`、`Entity`、`System`、`World`、`EngineError`、`EngineErrorCode`；
   - 3D：`Camera3D`、`CartesianTransform3D`、`SphericalTransform3D`、`Mesh3D`、`Geometry3D`；
   - 2D：`Camera2D`、`Transform2D`、`Mesh2D`、`Geometry2D`、`Material2D`；
   - surface/light/color：`BasicMaterial`、`PbrMaterial`、`DirectionalLight`、`EnvironmentLight`、`ColorSRGB`；
   - creation/control：`createBox3D`、`createPlane3D`、`createSphere3D`、`OrbitControl`。
2. 其他 stable API 不删除，继续由 `package.json#exports` 中的 `/core`、`/assets`、`/ecs`、`/components`、`/geometry`、`/material`、`/lighting`、`/systems` 等领域子入口提供。
3. 不提供 legacy root re-export。仓库源码、tests、examples、games、editor 与 voxel editor 在同一变更中迁移。
4. 编辑器生成的独立 runtime project 必须按领域生成多条 import，不能重新把所有符号指向根入口。
5. `api:check` 对根入口执行集合完全相等检查，而不只是数量上限；30 个名额不可被无关概念替换。修改名单必须由新的 ADR 决策。
6. workspace source bundle 对所有公开 engine subpath 使用统一 alias，避免同一 bundle 同时加载 source root 与 dist subpath，破坏 class identity。

## 结果

- Getting started 和常规 2D/3D 场景仍可只使用默认入口。
- 高级能力的 import 本身表达领域归属，自动补全和文档导航更清晰。
- 这是一次有意的破坏式变更；当前项目尚无兼容窗口，因此不保留过渡层。
- ADR 0023 对 stable 子入口、experimental 泄漏和声明边界的其他约束继续有效；本 ADR 取代其后续 ADR 中对根入口数字预算的增长结论。

## 验证

- `npm run api:check`
- `npm run typecheck`
- `npm run check:boundaries`
- `npm test`
- `npm run build`
