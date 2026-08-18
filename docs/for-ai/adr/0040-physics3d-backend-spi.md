# ADR 0040：3D 物理复用 Backend SPI 边界并采用 Rapier adapter

- 状态：Accepted
- 日期：2026-07-23
- 影响：`@haiyue/engine/physics`、`@haiyue/engine/physics/backend`、Physics3D ECS 组件与 examples

## 背景

引擎已有通过 Backend SPI 与 Box2D 解耦的 2D 物理，但没有 3D 刚体、关节、空间查询和力场能力。若让 ECS 组件直接持有 Rapier 对象，游戏逻辑、序列化和编辑器会依赖第三方对象生命周期，也无法替换后端。

3D 的 quaternion、shape、joint、空间 ray cast 和 force-at-point 协议明显不同于 2D。把两者强行合并为一个维度无关接口会产生大量可选字段，并削弱类型约束。

## 决策

1. 3D 物理沿用 ADR 0038 的分层方式，但保留独立的 3D 描述协议。ECS 与游戏代码只使用 `Physics3DBody`、`Physics3DJoint`、`Physics3DSystem` 和 opaque handle。
2. `Physics3DSystem` 必须显式注入 `Physics3DBackend`。核心系统不导入 Rapier，也不隐藏 WASM 的异步初始化。
3. Rapier adapter 只从 `@haiyue/engine/physics/backend` 导出；其 native body、collider、joint、World 和 WASM 模块不得进入组件或序列化结果。
4. World driver 统一提供刚体、collider、六类 joint、ray cast、force-at-point、冲量和临时拖拽约束。后端能力差异通过 `Physics3DCapabilities` 表达。
5. 固定时间步、ECS 生命周期、Transform3D 同步、描述变更和 joint 重建由 `Physics3DSystem` 负责。运行时修改后端不支持的构造期属性时允许从组件描述重建刚体。
6. 浮力与平方反比天体引力实现为只调用通用 force API 的独立系统，不允许导入 Rapier。
7. 布料第一版采用刚体节点与 spring joint 的离散模型；动态 Geometry3D 仅可视化节点结果，不成为物理协议的一部分。
8. `Physics3DBody`、`Physics3DJoint`、`Physics3DBuoyancy` 和 `Physics3DGravitySource` 进入核心组件序列化；运行时 handle 与求解器状态不持久化。
9. stable `@haiyue/engine/physics` 预算由 16 调整为 37，新增普通 3D 领域组件、系统及其 options 类型。`@haiyue/engine/physics/backend` 预算由 19 调整为 44，容纳并列的 2D/3D SPI 与 Rapier factory。默认根入口保持不变。

## 结果

- 3D 游戏逻辑可以替换后端，且不会接触 Rapier 对象。
- 2D 与 3D 共享架构原则和生命周期规则，但各自保持清晰的强类型协议。
- Rapier compat 的异步 WASM 初始化只发生在组合根或 example，不污染通用系统。
- 浮力、引力、拖拽和布料可用于验证力、空间查询和大量约束，不会扩张后端专用 API。

## 验证

- `npm run typecheck -w ./engine`
- `npm run build -w ./engine`
- `node --test engine/test/physics3d-backend.test.mjs engine/test/physics3d-serialization.test.mjs`
- `npm run typecheck -w ./examples`
- 分别构建 `physics3d-collision`、`physics3d-joints`、`physics3d-buoyancy`、`physics3d-orbital-gravity`、`physics3d-cloth`
- `npm run modules:check`
- `npm run examples:catalog:check`
- `npm run api:check`
