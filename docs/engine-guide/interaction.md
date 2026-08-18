# 点击、拖拽与键盘交互

海月引擎把游戏交互拆成几个可组合的 stable API：

- `Interactive` 描述一个 3D entity 如何响应 pointer 事件。
- `InteractionSystem` 把 Canvas 坐标转换成相机射线，并对 `Mesh3D` 做拾取。
- `KeyboardComponent` 保存逐帧键盘状态，`InputMap` 把物理按键映射为游戏 action。
- `BoxSelectionControl`、`OrbitControl` 等 control 负责常见的复合 pointer 手势。
- `FirstPersonControls` 负责 Pointer Lock 视角、WASD、重力、跳跃和可注入的地面采样。

普通 HTML 表单和 DOM 按钮仍应使用浏览器事件。这里重点说明游戏场景中的 3D 点击、拖拽和逐帧键盘控制。

## 启用 3D 点击与 Hover

先为场景添加一个 `InteractionSystem`。它是非渲染 system，因此传入 `false`，只让它参与 `World.update()`：

```ts
import { Interactive } from '@haiyue/engine/components';
import { InteractionSystem } from '@haiyue/engine/systems';

const interaction = new InteractionSystem(
  engine,
  scene.cameraEntity,
  {
    useBVH: true,
    spatialIndex: true,
    continuousHover: false,
  },
);
scene.addSystem(interaction, false);
```

然后把 `Interactive` 添加到已经拥有 `Mesh3D` 的 entity：

```ts
const interactive = new Interactive({
  onPointerEnter: event => {
    canvas.style.cursor = 'pointer';
    console.log('enter', event.entity.name);
  },
  onPointerLeave: event => {
    canvas.style.cursor = 'default';
    console.log('leave', event.entity.name);
  },
  onPointerDown: event => {
    console.log('down at world position', Array.from(event.point));
  },
  onPointerUp: event => {
    console.log('up', event.entity.name);
  },
  onClick: event => {
    console.log('click', event.entity.name, event.distance);
  },
});

buttonEntity.addComponent(interactive);
```

事件的 `point` 和 `normal` 是世界坐标。`nativeEvent` 是原始 `PointerEvent` 或 `MouseEvent`，可读取 `button`、`pointerId`、修饰键和屏幕坐标。

`InteractiveEvent` 是为减少逐帧分配而复用的临时对象。回调结束后仍要保存交点或法线时必须复制：

```ts
const savedHitPoints: Float32Array[] = [];

interactive.onClick = event => {
  savedHitPoints.push(new Float32Array(event.point));
};
```

### 拾取和遮挡规则

`InteractionSystem` 对 `Mesh3D` 使用以下规则：

| Entity 组成 | 拾取行为 |
| --- | --- |
| `Mesh3D`，没有 `Interactive` | 阻挡射线，但不触发事件 |
| `Mesh3D + Interactive` | 触发事件，并阻挡射线 |
| `Mesh3D + Interactive({ penetrable: true })` | 完全跳过：不阻挡，也不触发事件 |

所以 `penetrable` 不是“接收事件后继续传播”，而是让对象对拾取完全透明。被禁用的 entity 或被禁用父节点下的 entity 不参与拾取。

默认只在 pointer 状态变化时重新计算 Hover。如果对象会在静止鼠标下移动，并且需要及时触发 enter/leave，可启用：

```ts
interaction.continuousHover = true;
```

这会在每帧进行一次额外拾取，应只在确有需求时开启。

## 使用 Raycast 查询任意屏幕位置

需要由业务主动查询时，复用 `createInteractionRaycastResult()` 的输出对象：

```ts
import {
  createInteractionRaycastResult,
} from '@haiyue/engine/systems';

const raycastResult = createInteractionRaycastResult();

function pointerToNdc(event: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    1 - ((event.clientY - rect.top) / rect.height) * 2,
  ];
}

canvas.addEventListener('pointerdown', event => {
  const [ndcX, ndcY] = pointerToNdc(event);
  if (!interaction.raycast(scene.world, ndcX, ndcY, raycastResult)) return;

  console.log(
    raycastResult.entity?.name,
    raycastResult.distance,
    Array.from(raycastResult.point),
  );
});
```

NDC 的 X、Y 范围都是 `[-1, 1]`，Canvas 左上角对应 `[-1, 1]`。返回值可能是没有 `Interactive` 的遮挡物；主动 raycast 表示“最近的非 penetrable Mesh3D”，而不是“最近的可交互对象”。

## 在地面上拖拽 3D 对象

拖拽需要在 pointer 离开对象后继续接收事件，因此不能只依赖对象的 `onPointerMove`。常见做法是：

1. 用 `Interactive.onPointerDown` 选择对象。
2. 对 Canvas 设置 pointer capture。
3. 暂时把被拖对象设为 `penetrable`，让后续射线落到拖拽平面。
4. 在 Canvas 的 `pointermove` 中 raycast 地面并更新 transform。
5. 在 `pointerup` 或 `pointercancel` 中恢复状态。

下面假设 `groundEntity` 是带 `Mesh3D`、但没有 `Interactive` 的水平地面：

```ts
import { CartesianTransform3D } from '@haiyue/engine';
import { Interactive } from '@haiyue/engine/components';
import { createInteractionRaycastResult } from '@haiyue/engine/systems';

const transform = draggableEntity.getComponent(CartesianTransform3D);
if (!transform) throw new Error('Draggable entity requires CartesianTransform3D.');

const groundHit = createInteractionRaycastResult();
let activePointerId = -1;
let offsetX = 0;
let offsetZ = 0;
let fixedY = transform.position[1] ?? 0;

function hitGround(event: PointerEvent): boolean {
  const [ndcX, ndcY] = pointerToNdc(event);
  return interaction.raycast(scene.world, ndcX, ndcY, groundHit)
    && groundHit.entity === groundEntity;
}

const draggable = new Interactive({
  onPointerDown: event => {
    const native = event.nativeEvent;
    if (!(native instanceof PointerEvent) || native.button !== 0) return;

    // 先忽略被拖对象，才能查询它后面的地面交点。
    draggable.penetrable = true;
    if (!hitGround(native)) {
      draggable.penetrable = false;
      return;
    }

    activePointerId = native.pointerId;
    fixedY = transform.position[1] ?? 0;
    offsetX = (transform.position[0] ?? 0) - (groundHit.point[0] ?? 0);
    offsetZ = (transform.position[2] ?? 0) - (groundHit.point[2] ?? 0);
    canvas.setPointerCapture(native.pointerId);
  },
});
draggableEntity.addComponent(draggable);

const dragListeners = new AbortController();

canvas.addEventListener('pointermove', event => {
  if (event.pointerId !== activePointerId || !hitGround(event)) return;

  transform.setPosition(
    (groundHit.point[0] ?? 0) + offsetX,
    fixedY,
    (groundHit.point[2] ?? 0) + offsetZ,
  );
}, { signal: dragListeners.signal });

function finishDrag(event: PointerEvent) {
  if (event.pointerId !== activePointerId) return;
  activePointerId = -1;
  draggable.penetrable = false;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener('pointerup', finishDrag, {
  signal: dragListeners.signal,
});
canvas.addEventListener('pointercancel', finishDrag, {
  signal: dragListeners.signal,
});

// 切换场景或销毁应用时，清理业务自己注册的 DOM listener。
function disposeDragInteraction() {
  dragListeners.abort();
}
```

这种实现把对象限制在 XZ 地面。如果要沿任意平面拖拽，应使用相机射线与业务平面求交；如果要拖动物理刚体，应使用物理模块的 drag constraint，而不是每帧直接写 transform。

不要让对象拖拽和相机 `OrbitControl` 同时占用同一个 pointer button。可以在拖拽期间关闭相机旋转、给两者分配不同按钮，或通过 `inputRegion` 把相机输入限制在其他 Canvas 区域。

## 框选多个对象

RTS 或编辑器式矩形选择使用 `BoxSelectionControl`：

```ts
import { BoxSelectionControl } from '@haiyue/engine/controls';

const selection = new BoxSelectionControl(
  canvas,
  scene.world,
  scene.cameraEntity,
  {
    button: 0,
    minDragPixels: 4,
    selectionMode: 'center',
    filter: entity => entity.name.startsWith('Unit-'),
    onSelect: result => {
      console.log('selected', result.entities);
    },
  },
);

// 切换场景或不再使用时必须解除 DOM listener 并移除选择框。
selection.dispose();
```

`selectionMode` 可取：

- `center`：对象包围球中心位于选择体内。
- `intersect`：对象几何与选择体相交。
- `all`：对象几何完整位于选择体内。

Control 默认在 capture 阶段阻止同一次拖拽继续传给其他交互。与 `OrbitControl` 组合时，通常关闭左键旋转或给框选使用不同按钮。

## 逐帧读取键盘

`KeyboardComponent` 只有加入 world 后才会安装键盘 listener 并推进输入帧。把它挂到需要接收游戏输入的 entity：

```ts
import {
  CartesianTransform3D,
  Entity,
} from '@haiyue/engine';
import { KeyboardComponent } from '@haiyue/engine/components';
import { System } from '@haiyue/engine/ecs';
import { InputMap } from '@haiyue/engine/input';

KeyboardComponent.setInputMap(new InputMap({
  MoveLeft: ['KeyA', 'ArrowLeft'],
  MoveRight: ['KeyD', 'ArrowRight'],
  Interact: ['KeyE', 'Space'],
  Pause: ['Escape', 'KeyP'],
}));

const player = new Entity('Player');
player.addComponent(new CartesianTransform3D());
player.addComponent(new KeyboardComponent());
scene.add(player);

const playerInput = new System(
  { all: [KeyboardComponent, CartesianTransform3D] },
  (entity, _time, delta) => {
    const input = entity.getComponent(KeyboardComponent);
    const transform = entity.getComponent(CartesianTransform3D);
    if (!input || !transform) return;

    let axis = 0;
    if (input.isPressed('MoveLeft')) axis -= 1;
    if (input.isPressed('MoveRight')) axis += 1;

    const seconds = Math.min(delta, 50) / 1000;
    const position = transform.position;
    transform.setPosition(
      (position[0] ?? 0) + axis * 4 * seconds,
      position[1] ?? 0,
      position[2] ?? 0,
    );

    if (input.wasPressed('Interact')) {
      interactWithNearestObject(entity);
    }
    if (input.wasReleased('Pause')) {
      console.log('Pause key released');
    }
  },
  'PlayerInputSystem',
);
scene.addSystem(playerInput, false);
```

三个常用状态分别是：

| API | 含义 | 典型用途 |
| --- | --- | --- |
| `isPressed(actionOrCode)` | 当前持续按下 | 移动、瞄准、蓄力 |
| `wasPressed(actionOrCode)` | 本帧刚按下 | 跳跃、交互、打开菜单 |
| `wasReleased(actionOrCode)` | 本帧刚释放 | 结束蓄力、确认松开 |

这些 API 优先匹配 `InputMap` action；没有同名 action 时会把参数当作 `KeyboardEvent.code`。如果只想查询物理按键而不解析 action，使用 `isKeyPressed()`、`wasKeyPressed()` 和 `wasKeyReleased()`。

输入 map 和底层键盘状态由所有 `KeyboardComponent` 实例共享，通常在场景或游戏启动时配置一次。`preventDefaultForMappedKeys` 默认为 `true`，会阻止已映射游戏按键触发页面滚动等默认行为，但不会拦截 `input`、`textarea`、`select` 或 `contenteditable` 中的输入：

```ts
KeyboardComponent.preventDefaultForMappedKeys = true;
KeyboardComponent.defineAction('ToggleMap', ['KeyM']);
```

`World.update()` 会先更新 component 输入帧，再执行 system，所以在 scene system 中查询 `wasPressed()` 可以得到正确的边沿状态。`engine.on('update')` 发生在 active scene 更新之前，不适合查询本帧键盘边沿；必须从 engine listener 查询时使用 `after-update`，游戏逻辑仍优先放在 system 或 component update 中。

文本输入、输入法组合和快捷键焦点管理应继续使用 DOM/GUI 输入组件，不要把 `KeyboardComponent` 当作文本编辑器。

## 第一人称移动、跳跃与地面探针

`FirstPersonControls` 位于 `@haiyue/engine/controls`，不进入根入口。它默认作为优先级 -100 的非渲染 system，在相机快照前更新目标 `CartesianTransform3D`：

```ts
import { FirstPersonControls } from '@haiyue/engine/controls';

const sample = new Float32Array(3);
const controls = new FirstPersonControls(engine.canvas!, playerTransform, {
  moveSpeed: 4.2,
  jumpSpeed: 5.5,
  gravity: 16,
  groundOffset: playerRadius,
  maxStepHeight: 0.12,
  groundProbe: position => (
    navMesh.sampleSurface(position, { radius: 0 }, sample)?.[1] ?? null
  ),
});

scene.addSystem(controls, false);
```

点击 Canvas 后浏览器进入 Pointer Lock；WASD/方向键移动，Shift 加速，Space 跳跃，Escape 由浏览器释放指针。Pointer Lock 不可用或显式关闭时，按住 Canvas 拖拽仍可观察。目标 transform 可以直接属于相机，也可以属于带球体/胶囊 Mesh 的玩家根 entity，相机作为 child 提供眼睛偏移。

`groundProbe` 只负责返回当前位置的地面 Y。返回 `null` 会让角色进入下落，因此适合连接 `NavMesh.sampleSurface()` 的洞判断。精确墙体 sweep、移动平台和胶囊接触仍应连接物理角色控制器；不要把 `projectPoint()` 当地面探针，因为它会把洞中的点投影到附近表面。

## 生命周期与常见问题

- `InteractionSystem` 必须使用正在显示该 world 的相机；切换 active camera 后应创建或配置对应的 interaction system。
- Pointer 事件会排队到下一次 world update 执行，不要假设 handler 与原生 DOM dispatch 同步。
- `Interactive` 只处理带 `Mesh3D` 的 entity；2D GUI 使用 GUI 自己的 pointer handler。
- `InteractionSystem.destroy()` 会解除它注册的 Canvas listener；业务直接注册的 DOM listener、`OrbitControl`、`FirstPersonControls` 和 `BoxSelectionControl` 也应在退出时 dispose。
- Click 与 drag 应有明确的移动阈值。拖拽对象不应同时把浏览器生成的 `click` 当成一次业务点击。
- 大量静态或动态 Mesh 默认使用空间索引和几何 BVH。除非在定位问题，不要关闭 `spatialIndex` 或 `useBVH`。

## 可运行示例

- [`examples/interactive`](../../examples/interactive/)：3D click、hover、遮挡与 penetrable 规则。
- [`examples/box-selection`](../../examples/box-selection/)：矩形拖拽框选和三种 selection mode。
- [`examples/orbit-control`](../../examples/orbit-control/)：旋转、平移、缩放和触摸手势。
- [`examples/navmesh-first-person`](../../examples/navmesh-first-person/)：Pointer Lock 球体、NavMesh 表面洞、重力、跳跃和低台阶。
- [`examples/physics3d-collision`](../../examples/physics3d-collision/)：通过 drag constraint 拖动 3D 刚体。
- [`examples/box2d-mouse-drag`](../../examples/box2d-mouse-drag/)：通过 mouse joint 拖动 2D 刚体。
