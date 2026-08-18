# Physics API

## `@haiyue/engine/physics`

- `Physics2DBody`：刚体与单个 box/circle collider 的可序列化描述；`handle` 是只读运行时句柄。
- `Physics2DJoint`：revolute/distance joint 描述；`handle` 是只读运行时句柄。
- `Physics2DSystem`：固定时间步、Transform 同步、查询、力/冲量、速度、传送和鼠标关节门面。
- `Physics2DTo3DTransformSync`、`Physics2DTo3DTransformSyncSystem`：将 2D 物理结果映射到 3D 展示。

`Physics2DSystemOptions.backend` 接受自定义后端；省略时创建 Box2D adapter。`capabilities` 和 `backendId` 可用于诊断与能力检查。

3D 领域 API：

- `Physics3DBody`：static/dynamic/kinematic 刚体和 box/sphere/capsule/cylinder collider 描述。
- `Physics3DJoint`：fixed/spherical/revolute/prismatic/spring/rope 约束描述。
- `Physics3DSystem`：固定时间步、Transform3D 同步、ray cast、力/力矩/冲量、速度、传送和拖拽约束门面。
- `Physics3DBuoyancy`、`Physics3DBuoyancySystem`：通过通用 force-at-point API 计算浮力和流体阻力。
- `Physics3DGravitySource`、`Physics3DGravitySystem`：通过通用 force API 计算软化后的平方反比点引力。

`Physics3DSystemOptions.backend` 是必填项；内置 Rapier adapter 需要先异步初始化。

## `@haiyue/engine/physics/backend`

该入口是物理后端的 service-provider interface：

- `Physics2DBackend`：后端工厂。
- `Physics2DWorldDriver`：单个物理 World 的低层驱动协议。
- `Physics2DBodyHandle`、`Physics2DJointHandle`：opaque 数值句柄。
- `Physics2DBackend*Desc`：使用米和弧度的后端描述。
- `Physics2DCapabilities`：body、shape、joint、CCD、查询和事件能力。
- `createBox2DPhysics2DBackend()`：显式创建内置 Box2D adapter。
- `Physics3DBackend`、`Physics3DWorldDriver`：3D 后端工厂与 World 驱动协议。
- `Physics3DBodyHandle`、`Physics3DJointHandle`、`Physics3DDragHandle`：3D opaque 数值句柄。
- `Physics3DBackend*Desc`、`Physics3DCapabilities`：3D 描述和能力集合。
- `createRapierPhysics3DBackend()`：初始化内联 WASM 并创建 Rapier 3D adapter。

精确签名以 `engine/dist/physics.d.ts` 和 `engine/dist/physics/backend.d.ts` 为准。使用方法见 [2D 物理指南](../engine-guide/physics-2d.md)与 [3D 物理指南](../engine-guide/physics-3d.md)。
