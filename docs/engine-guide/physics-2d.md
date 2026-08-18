# 2D 物理与可替换后端

`@haiyue/engine/physics` 提供 ECS 组件和统一运行时 API。默认实现是 Box2D，但游戏代码不应访问 Box2D 对象；力、速度、查询和关节操作都通过 `Physics2DSystem` 完成。

```ts
import { Entity, Transform2D, World } from '@haiyue/engine';
import { Physics2DBody, Physics2DSystem } from '@haiyue/engine/physics';

const world = new World();
const physics = new Physics2DSystem({
  gravity: [0, -980],
  pixelsPerMeter: 100,
});
world.addSystem(physics);

const ball = new Entity('Ball');
const rigidBody = new Physics2DBody({
  type: 'dynamic',
  shape: 'circle',
  radius: 24,
  density: 1,
});
ball.addComponent(new Transform2D({ x: 0, y: 200 }));
ball.addComponent(rigidBody);
world.addEntity(ball);

// 第一次 World.update() 后 handle 才有效。
physics.applyLinearImpulse(rigidBody, 1.5, 3);

const velocity = { x: 0, y: 0 };
if (physics.getLinearVelocity(rigidBody, velocity)) {
  console.log(velocity.x, velocity.y);
}
```

## 坐标和单位

- `Transform2D`、`hitTest()`、`teleportBody()` 和系统 gravity 使用渲染坐标单位。
- `pixelsPerMeter` 将上述长度转换为后端物理世界的米。
- 线速度、力、冲量和 `maxForce` 使用物理世界单位；角度使用弧度。
- 查询结果使用 `out` 参数，帧循环中应复用结果对象。

## 运行时句柄

`Physics2DBody.handle` 和 `Physics2DJoint.handle` 是后端无关的 opaque handle。组件刚加入 World、已经移除或系统销毁时为 `null`。句柄只属于创建它的物理 World，不能持久化，也不能跨 World 使用。

场景数据只保存组件描述；后端对象、接触缓存和求解器状态不会进入序列化结果。

## 选择其他后端

后端实现者从高级 SPI 入口导入协议：

```ts
import type { Physics2DBackend } from '@haiyue/engine/physics/backend';
import { Physics2DSystem } from '@haiyue/engine/physics';

declare const customBackend: Physics2DBackend;
const physics = new Physics2DSystem({ backend: customBackend });
```

每个 `Physics2DBackend` 创建独立的 `Physics2DWorldDriver`。驱动使用米、数值句柄和可复用输出对象，不得把第三方对象放进 ECS 组件。能力差异通过 `capabilities` 查询；不支持的 shape 或 joint 应在创建时明确失败。

运行中的 World 不支持无损热切换后端。需要切换时，应保留组件描述，销毁旧 `Physics2DSystem`，再用新后端重建物理 World。

## 编辑器脚本

启用 `physics` capability 后，脚本通过 `api.physics` 调用统一门面：`body`、`hitTest`、`getMass`、`getVelocity`、`setVelocity`、`setAngularVelocity`、`applyForce`、`applyImpulse`、`teleport` 和 `stop`。`getVelocity(target, out)` 支持复用输出对象。脚本不得读取 `Physics2DBody.body`；该后端对象入口已经移除。
