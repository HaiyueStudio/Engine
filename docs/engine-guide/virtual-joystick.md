# 用虚拟摇杆移动角色

[Virtual Joystick 示例](../../examples/virtual-joystick/index.html) 展示可切换的固定/浮动摇杆、可调最大偏移和速度，以及每帧输入读数。摇杆与 HUD 都由 Engine GUI 绘制。公开参数见 [Controls API](../api/controls.md)。

```ts
import { Entity, CartesianTransform3D } from '@haiyue/engine';
import { GuiRoot } from '@haiyue/engine/gui';
import { VirtualJoystickControls } from '@haiyue/extensions/controls';

// engine 已初始化；scene 使用 gui: true，canvas 为 engine.canvas。
const player = new Entity('Player').addComponent(new CartesianTransform3D());
scene.add(player); // 再添加角色 mesh 或模型子节点。
const hud = new GuiRoot();
scene.add(new Entity('HUD').addComponent(hud));
canvas.style.touchAction = 'none';

const joystick = new VirtualJoystickControls(canvas, {
  guiRoot: hud,
  target: player,
  mode: 'floating',
  region: ({ width, height }) => ({
    x: 0, y: height * 0.5, width: width * 0.5, height: height * 0.5,
  }),
  maxDistance: 70,
  deadZone: 0.12,
  moveSpeed: 4,
  turnSpeed: Math.PI * 4,
});
scene.addSystem(joystick, false);

joystick.events.on('frame', ({ detail }) => {
  const { deltaSeconds, direction, distance, strength } = detail;
  // 可据此驱动移动动画、脚步声、网络输入或自定义角色控制器。
});
```

固定在屏幕左下方：

```ts
joystick.configure({
  mode: 'fixed',
  center: ({ height }) => ({ x: 110, y: height - 120 }),
  maxDistance: 64,
});
```

center 和 region 回调使横竖屏自动使用新的逻辑尺寸。边界移动会取消当前手势；玩家重新按下即可继续。固定摇杆命中必须同时位于 region 和 activationRadius 内，避免区域外抢占其他按钮；复杂 HUD 可用 shouldActivate 进一步排除。

如果用自定义物理移动，省略 target，只读取逐帧事件；若自己绘制摇杆，省略 guiRoot，使用 state.center、state.offset 和 active。浮动模式以本次按下点为固定中心，拖动超出 maxDistance 后摇杆头停在圆周，力度保持 1。

scene 会驱动每帧更新并在销毁时销毁系统。手动集成宿主循环时，每帧调用一次 `joystick.step(dtMilliseconds)`；不要再把它作为系统加入场景，否则会重复移动。宿主暂停/触摸中断时调用 `joystick.cancel()`，退出时调用 `joystick.destroy()`。

```sh
npm run build:target -- example:virtual-joystick
node scripts/verify-virtual-joystick.mjs
```
