# ADR 0038：2D 物理采用统一门面和可替换 Backend SPI

- 状态：Accepted
- 日期：2026-07-22
- 影响：`@haiyue/engine/physics`、`@haiyue/engine/physics/backend`、Physics2D ECS 组件

## 背景

原实现由 `Physics2DSystem` 直接创建和操作 Box2D，`Physics2DBody.body` 与 `Physics2DJoint.joint` 还把第三方对象暴露给游戏和编辑器运行时。上层代码因此依赖 Box2D 命名、对象生命周期和单位，无法替换实现，也无法把同一设计用于 3D 物理。

## 决策

1. stable `@haiyue/engine/physics` 保持现有 16 个领域概念预算，面向普通游戏代码提供组件和系统门面。
2. 新增 stable `@haiyue/engine/physics/backend`，19 个符号预算，专门提供后端 SPI、描述、capability 和 opaque handle。
3. ECS 组件不保存第三方对象，只通过运行时 WeakMap 暴露只读数值 handle；handle 不参与序列化。
4. `Physics2DSystem` 负责渲染坐标与物理米之间的转换、固定时间步、ECS 生命周期和 Transform 同步。
5. Backend driver 负责刚体、collider、joint、查询和求解器调用，并使用 out 参数避免查询热路径分配。
6. Box2D 是默认 adapter，不是公共领域模型。其他后端通过 `Physics2DSystemOptions.backend` 注入。
7. 不承诺运行中无损热切换；切换后端通过描述数据重建 World。
8. 2D 与未来 3D 物理共享设计语言和生命周期规则，但不合并 shape、旋转和 joint 协议。

## 结果

- 游戏、编辑器脚本和示例不再访问 Box2D 对象。
- 可通过 recording/null backend 测试 ECS 协调逻辑，也可新增 Rapier2D 等 adapter。
- 后端 SPI 的增长受到独立入口预算约束，不扩大普通 physics 自动补全表面。

## 验证

- `npm run build -w ./engine`
- `node --test engine/test/physics2d-backend.test.mjs`
- `npm run modules:check`
- `npm run docs:check`
- `npm run api:check`
