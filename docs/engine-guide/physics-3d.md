# 3D 物理与 Rapier adapter

3D 物理分为普通领域入口和后端 SPI。游戏代码使用 `Physics3DBody`、`Physics3DJoint` 与 `Physics3DSystem`；只有应用组合根负责选择并初始化具体后端。

```ts
import { Entity } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Physics3DBody, Physics3DSystem } from '@haiyue/engine/physics';
import { createRapierPhysics3DBackend } from '@haiyue/engine/physics/backend';

const backend = await createRapierPhysics3DBackend();
const physics = new Physics3DSystem({
  backend,
  gravity: [0, -9.81, 0],
  fixedTimeStep: 1 / 60,
});
scene.addSystem(physics, false);

const ball = new Entity('Ball');
ball.addComponent(new Transform3D());
const rigidBody = new Physics3DBody({
  type: 'dynamic',
  shape: 'sphere',
  radius: 0.5,
  density: 1,
  ccd: true,
});
ball.addComponent(rigidBody);
scene.add(ball);
```

`Physics3DBody.handle` 在系统第一次同步后才有效。它是当前物理 World 内的 opaque 数值句柄，不得持久化或跨 World 使用。组件、场景 JSON 和编辑器数据都不保存 Rapier 对象。

## 交互和查询

`Physics3DSystem` 统一提供 `castRay()`、`applyForce()`、`applyForceAtPoint()`、力矩、线性/角冲量、速度和 `teleportBody()`。鼠标拖拽使用临时的 `createDragConstraint()`、`updateDragConstraint()` 与 `destroyDragConstraint()`，上层不需要知道后端如何实现拖拽约束。

所有长度使用 3D 世界单位，角度使用弧度，旋转使用 xyzw quaternion。固定时间步的输入 delta 仍由引擎以毫秒传给 System。

## 关节

`Physics3DJoint` 的 anchor 与 axis 均位于各刚体局部空间。支持：

- `fixed`：锁定相对位姿。
- `spherical`：球形关节。
- `revolute`：单轴转动，可设置角度 limits。
- `prismatic`：单轴平移，可设置距离 limits。
- `spring`：rest length、stiffness 和 damping。
- `rope`：最大距离约束。

joint 引用 Entity、Entity id 或名称。关联刚体尚未创建时，系统会等待；描述变化或刚体重建时，joint 会从组件数据重建。

## 力场扩展

`Physics3DBuoyancySystem` 与 `Physics3DGravitySystem` 只依赖通用系统 API，可和其他 3D 后端复用。它们的 priority 默认位于 `Physics3DSystem` 之前，以便在当次固定步进前施力。

布料示例使用刚体节点和 spring joint 展示可组合的约束模型，它不是后端专用 cloth API。

## 自定义后端

实现者从 `@haiyue/engine/physics/backend` 导入 `Physics3DBackend` 和 `Physics3DWorldDriver`。driver 必须使用 opaque handle，不得把第三方 native 对象写入 ECS 组件。运行中不支持无损切换后端；应保留组件描述、销毁旧系统，再用新 backend 重建 World。

参考示例：

- `examples/physics3d-collision`
- `examples/physics3d-joints`
- `examples/physics3d-buoyancy`
- `examples/physics3d-orbital-gravity`
- `examples/physics3d-cloth`
