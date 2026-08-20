# 2D 小游戏实战：从需求拆解到完成打砖块

本教程不从一份数百行的最终代码开始，而是先拆解打砖块的需求，再逐个完成模块。每完成一节，项目都会多一块明确的能力；最后通过入口文件把它们组装成一个完整游戏。

打砖块适合作为第一个 2D 实战，因为它规则直观、不依赖美术资源，同时能覆盖大多数小游戏都会用到的 API：

- 2D 场景、正交相机、Geometry、Material 和 Transform；
- Entity、Component、System；
- 键盘 Action、Pointer 和屏幕坐标转换；
- 逐帧移动、碰撞、实体增删；
- 分数、生命、胜负与重开。

## 1. 先把需求变成模块

### 1.1 游戏规则

先写清楚本教程要交付什么：

1. 球拍能用 A/D、左右方向键或鼠标移动。
2. 空格或点击画面发球。
3. 球能与左右墙、顶墙、球拍和砖块碰撞。
4. 击中砖块得 100 分，砖块从场景中消失。
5. 球掉出底边失去一条生命，三条生命用完则失败。
6. 清除全部砖块则胜利。
7. 按 R，或在结束后按空格/点击画面，可以重新开始。
8. 游戏在不同 Canvas 尺寸下保持完整可见。

### 1.2 模块边界

不要按“代码写到多少行”拆文件，而要按变化原因拆：

| 模块 | 解决的问题 | 主要依赖 |
| --- | --- | --- |
| `config.ts` | 统一设计尺寸、速度、边界和规则参数 | 无 |
| `actors.ts` | 创建背景、墙、球拍、球和砖块 | 2D 渲染 API、config |
| `BreakoutState.ts` | 保存一局游戏的可变状态 | ECS Component、actors |
| `collision.ts` | 提供可测试的圆形与矩形碰撞算法 | 无 |
| `BreakoutInput.ts` | 把 Pointer 转换成游戏输入 | Canvas、Camera2D |
| `BreakoutSystem.ts` | 编排移动、碰撞、计分和胜负 | 前面所有模块 |
| `main.ts` | 初始化引擎并组装模块 | Scene、InputMap |

最终目录如下：

```text
breakout/
├── index.html
└── src/
    ├── main.ts
    └── game/
        ├── config.ts
        ├── actors.ts
        ├── collision.ts
        ├── BreakoutInput.ts
        ├── BreakoutState.ts
        └── BreakoutSystem.ts
```

依赖方向始终从具体规则指向通用能力：

```text
main
├── actors ── config
├── BreakoutState ── actors
├── BreakoutInput
└── BreakoutSystem
    ├── config
    ├── collision
    ├── BreakoutInput
    └── BreakoutState
```

`collision.ts` 不知道引擎，`actors.ts` 不知道得分，入口文件也不处理碰撞。这个边界会让后续替换物理实现或关卡数据更容易。

## 2. 建立页面和 HUD

游戏对象由 WebGPU 渲染，分数和提示使用普通 DOM。DOM 很适合 HUD、菜单和无障碍文本，也不需要为了三行文字引入额外的场景组件。

创建 `index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Haiyue Breakout</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; }
      body {
        overflow: hidden;
        color: #e8f1ff;
        background: #07101f;
        font: 14px/1.5 system-ui, sans-serif;
      }
      canvas {
        display: block;
        width: 100%;
        height: 100%;
        touch-action: none;
      }
      #hud {
        position: fixed;
        inset: 16px 20px auto;
        display: flex;
        justify-content: space-between;
        pointer-events: none;
        text-shadow: 0 2px 8px #000;
      }
      #message {
        position: fixed;
        left: 50%;
        bottom: 24px;
        transform: translateX(-50%);
        color: #a9bdd9;
        pointer-events: none;
      }
    </style>
  </head>
  <body>
    <canvas id="game"></canvas>
    <div id="hud">
      <span id="score">得分 0</span>
      <span id="lives">生命 3</span>
    </div>
    <div id="message">A/D 或方向键移动，空格或点击画面发球</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Canvas 用 CSS 填满窗口，实际像素尺寸由引擎管理。`touch-action: none` 可以防止触摸拖动被浏览器解释成页面滚动。

## 3. 模块一：定义游戏空间与规则参数

示例采用 800 × 600 的设计分辨率。2D 世界原点在中心，X 向右、Y 向上：

```text
                 y = 300
        ┌─────────────────────┐
        │      bricks         │
        │                     │
x=-400  │        ball         │  x=400
        │                     │
        │       paddle        │
        └─────────────────────┘
                 y = -300
```

把不会在一局游戏中变化的数值放进 `src/game/config.ts`：

```ts
export const DESIGN_WIDTH = 800;
export const DESIGN_HEIGHT = 600;

export const PLAYFIELD = {
  left: -380,
  right: 380,
  top: 280,
  bottom: -300,
} as const;

export const RAIL = {
  thickness: 20,
} as const;

export const PADDLE = {
  width: 120,
  height: 18,
  y: -250,
  speed: 540,
} as const;

export const BALL = {
  radius: 10,
  speed: 360,
} as const;

export const BRICKS = {
  columns: 10,
  rows: 5,
  width: 64,
  height: 24,
  gapX: 8,
  gapY: 10,
  startY: 210,
  score: 100,
} as const;

export type GamePhase = 'ready' | 'playing' | 'won' | 'lost';
```

这些是玩法规则，不是渲染细节。以后调整关卡密度、球速或设计分辨率时，不需要进入碰撞代码寻找魔法数字。

## 4. 模块二：通过代码构建 2D 场景对象

### 4.1 一个可渲染对象由什么组成

本例中的球不是特殊的 `BallEntity` 子类。它是一个 Entity，加上两个组件：

```text
Entity "Ball"
├── Transform2D：位置、旋转和缩放
└── Mesh2D：Geometry2D + Material2D
```

因此先写一个小工厂，随后用它创建所有对象。创建 `src/game/actors.ts`：

```ts
import {
  ColorSRGB,
  Entity,
  Geometry2D,
  Material2D,
  Mesh2D,
  Scene,
  Transform2D,
} from '@haiyue/engine';
import { createCircle2D, createRect2D } from '@haiyue/engine/geometry';
import {
  BALL,
  BRICKS,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  PADDLE,
  RAIL,
} from './config';

export interface Actor {
  entity: Entity;
  transform: Transform2D;
}

export interface Brick extends Actor {
  width: number;
  height: number;
  active: boolean;
}

export interface BreakoutActors {
  paddle: Actor;
  ball: Actor;
  bricks: Brick[];
}

function createActor(
  name: string,
  geometry: Geometry2D,
  material: Material2D,
  x: number,
  y: number,
): Actor {
  const entity = new Entity(name);
  const transform = new Transform2D({ x, y });
  entity.addComponent(transform);
  entity.addComponent(new Mesh2D(geometry, material));
  return { entity, transform };
}

export function buildActors(scene: Scene): BreakoutActors {
  const background = createActor(
    'Background',
    createRect2D({ width: DESIGN_WIDTH, height: DESIGN_HEIGHT }),
    new Material2D({ color: new ColorSRGB(0.035, 0.08, 0.16, 1) }),
    0,
    0,
  );
  scene.add(background.entity);

  const railMaterial = new Material2D({
    color: new ColorSRGB(0.17, 0.28, 0.46, 1),
  });
  const rails = [
    createActor(
      'LeftRail',
      createRect2D({
        width: RAIL.thickness,
        height: DESIGN_HEIGHT - RAIL.thickness,
      }),
      railMaterial,
      -DESIGN_WIDTH / 2 + RAIL.thickness / 2,
      0,
    ),
    createActor(
      'RightRail',
      createRect2D({
        width: RAIL.thickness,
        height: DESIGN_HEIGHT - RAIL.thickness,
      }),
      railMaterial,
      DESIGN_WIDTH / 2 - RAIL.thickness / 2,
      0,
    ),
    createActor(
      'TopRail',
      createRect2D({
        width: DESIGN_WIDTH,
        height: RAIL.thickness,
      }),
      railMaterial,
      0,
      DESIGN_HEIGHT / 2 - RAIL.thickness / 2,
    ),
  ];
  for (const rail of rails) scene.add(rail.entity);

  const paddle = createActor(
    'Paddle',
    createRect2D({ width: PADDLE.width, height: PADDLE.height }),
    new Material2D({ color: new ColorSRGB(0.35, 0.82, 1, 1) }),
    0,
    PADDLE.y,
  );
  scene.add(paddle.entity);

  const ball = createActor(
    'Ball',
    createCircle2D({ radius: BALL.radius, segments: 32 }),
    new Material2D({ color: new ColorSRGB(1, 0.95, 0.72, 1) }),
    0,
    PADDLE.y + 30,
  );
  scene.add(ball.entity);

  const brickGeometry = createRect2D({
    width: BRICKS.width,
    height: BRICKS.height,
  });
  const rowMaterials = [
    new Material2D({ color: new ColorSRGB(1, 0.32, 0.38, 1) }),
    new Material2D({ color: new ColorSRGB(1, 0.56, 0.24, 1) }),
    new Material2D({ color: new ColorSRGB(1, 0.82, 0.26, 1) }),
    new Material2D({ color: new ColorSRGB(0.35, 0.82, 0.52, 1) }),
    new Material2D({ color: new ColorSRGB(0.46, 0.56, 1, 1) }),
  ];
  const startX =
    -((BRICKS.columns - 1) * (BRICKS.width + BRICKS.gapX)) / 2;
  const bricks: Brick[] = [];

  for (let row = 0; row < BRICKS.rows; row += 1) {
    for (let column = 0; column < BRICKS.columns; column += 1) {
      const actor = createActor(
        `Brick-${row}-${column}`,
        brickGeometry,
        rowMaterials[row]!,
        startX + column * (BRICKS.width + BRICKS.gapX),
        BRICKS.startY - row * (BRICKS.height + BRICKS.gapY),
      );
      scene.add(actor.entity);
      bricks.push({
        ...actor,
        width: BRICKS.width,
        height: BRICKS.height,
        active: true,
      });
    }
  }

  return { paddle, ball, bricks };
}
```

这里有两个值得保留的习惯：

- 相同形状的砖块共享一个 `Geometry2D`，避免重复创建几何资源。
- 同一行砖块共享一个 `Material2D`。修改共享 Material 会同时改变该行所有砖块，若要单独改色则应为该砖块创建独立 Material。

`actors.ts` 只负责“场景里有哪些对象”，尚未加入移动和碰撞。此时运行游戏应该能看到静态球、球拍和五行砖块。

## 5. 模块三：用 Component 保存一局游戏的状态

需要变化的数据包括分数、生命、游戏阶段、球速，以及对象引用。创建 `src/game/BreakoutState.ts`：

```ts
import { Component } from '@haiyue/engine';
import type { Actor, Brick } from './actors';
import { BALL, type GamePhase } from './config';

export interface BreakoutHud {
  score: HTMLElement;
  lives: HTMLElement;
  message: HTMLElement;
}

export class BreakoutState extends Component {
  score = 0;
  lives = 3;
  phase: GamePhase = 'ready';
  velocityX = BALL.speed * 0.62;
  velocityY = BALL.speed * 0.78;

  constructor(
    readonly paddle: Actor,
    readonly ball: Actor,
    readonly bricks: Brick[],
    readonly hud: BreakoutHud,
  ) {
    super('BreakoutState');
  }
}
```

`BreakoutState` 不处理输入，也不执行每帧逻辑。它只是该局游戏的状态容器。把状态放在 Component 中后，System 可以通过 ECS 查询找到要更新的游戏控制实体。

状态与配置的区别是：

- `BALL.speed` 是所有新游戏共用的规则；
- `velocityX` 是当前这局、当前这一帧的运行状态。

## 6. 模块四：把碰撞写成纯函数

球是圆形，球拍和砖块是轴对齐矩形。检测方法是找到矩形上距离圆心最近的点，再判断距离是否小于半径。

创建 `src/game/collision.ts`：

```ts
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function circleOverlapsRect(
  circleX: number,
  circleY: number,
  radius: number,
  rectX: number,
  rectY: number,
  width: number,
  height: number,
): boolean {
  const nearestX = clamp(
    circleX,
    rectX - width / 2,
    rectX + width / 2,
  );
  const nearestY = clamp(
    circleY,
    rectY - height / 2,
    rectY + height / 2,
  );
  const dx = circleX - nearestX;
  const dy = circleY - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}
```

这个模块没有 Entity、Transform 或 GPU 依赖，所以可以用普通单元测试覆盖边缘相切、完全重叠和未碰撞等情况。它只回答“是否相交”，至于反弹、得分还是销毁对象，由游戏规则模块决定。

## 7. 模块五：把 Pointer 输入适配到世界坐标

键盘输入已经由引擎的 `KeyboardComponent` 负责。Pointer 是浏览器事件，需要解决两个额外问题：

1. CSS 像素坐标不能直接作为世界坐标；
2. 监听器必须在游戏销毁时解除。

创建 `src/game/BreakoutInput.ts`：

```ts
import { Camera2D } from '@haiyue/engine';

export class BreakoutInput {
  pointerActive = false;
  pointerWorldX = 0;
  private launchRequested = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera2D,
  ) {
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
  }

  takeLaunchRequest(): boolean {
    const requested = this.launchRequested;
    this.launchRequested = false;
    return requested;
  }

  preferKeyboard(): void {
    this.pointerActive = false;
  }

  destroy(): void {
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointerActive = true;
    this.pointerWorldX = this.clientToWorldX(event.clientX);
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerActive = true;
    this.pointerWorldX = this.clientToWorldX(event.clientX);
    this.launchRequested = true;
    event.preventDefault();
  };

  private clientToWorldX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const normalizedX = (clientX - rect.left) / rect.width - 0.5;
    return normalizedX * this.camera.width / this.camera.zoom;
  }
}
```

`Camera2D.width` 会根据当前显示区域更新。因此坐标转换应读取相机的当前宽度，而不是固定乘 800。

完整的二维转换如下。Canvas 的 Y 向下，而 2D 世界的 Y 向上，所以 Y 需要反向：

```ts
const worldX =
  ((clientX - rect.left) / rect.width - 0.5) *
  camera.width /
  camera.zoom;
const worldY =
  (0.5 - (clientY - rect.top) / rect.height) *
  camera.height /
  camera.zoom;
```

本游戏的球拍只需要 X，因此输入模块只计算 `worldX`。

## 8. 模块六：编写逐帧游戏脚本

现在已经具备场景对象、状态、碰撞和 Pointer 输入，可以开始编排规则。

### 8.1 一帧中要做什么

`BreakoutSystem` 每帧按固定顺序执行：

```text
读取重开输入
  ↓
更新并限制球拍位置
  ↓
ready：让球跟随球拍，等待发球
playing：移动球
  ↓
墙壁碰撞 → 球拍碰撞 → 砖块碰撞
  ↓
检查掉落、胜利和失败
```

顺序很重要。例如先移动球、再检测碰撞，碰撞后必须做位置修正，否则下一帧球仍在物体内部，会连续反转速度。

### 8.2 为什么使用 System

World 会先更新 Component，再运行 System。`KeyboardComponent` 因此会先完成本帧输入采样，System 中的 `wasPressed()` 才能可靠表示“本帧刚按下”。

创建 `src/game/BreakoutSystem.ts`：

```ts
import {
  Entity,
  System,
  World,
} from '@haiyue/engine';
import { KeyboardComponent } from '@haiyue/engine/components';
import { BALL, BRICKS, PADDLE, PLAYFIELD } from './config';
import { circleOverlapsRect, clamp } from './collision';
import { BreakoutInput } from './BreakoutInput';
import { BreakoutState } from './BreakoutState';

export class BreakoutSystem extends System {
  constructor(private readonly pointer: BreakoutInput) {
    super(
      { all: [BreakoutState, KeyboardComponent] },
      undefined,
      'BreakoutSystem',
    );
  }

  override handle(
    entity: Entity,
    _time: number,
    delta: number,
    world: World,
  ): this {
    const state = entity.getComponent(BreakoutState);
    const keyboard = entity.getComponent(KeyboardComponent);
    if (!state || !keyboard) return this;

    // 引擎 delta 使用毫秒。限制最大步长，降低切回标签页时的穿透。
    const seconds = Math.min(delta, 32) / 1000;

    if (keyboard.wasPressed('Restart')) {
      this.resetGame(state, world);
    }

    this.updatePaddle(state, keyboard, seconds);

    const wantsLaunch =
      keyboard.wasPressed('Launch') || this.pointer.takeLaunchRequest();

    if (state.phase === 'ready') {
      this.attachBallToPaddle(state);
      if (wantsLaunch) this.launchBall(state);
      return this;
    }

    if (state.phase === 'won' || state.phase === 'lost') {
      if (wantsLaunch) this.resetGame(state, world);
      return this;
    }

    this.simulateBall(state, world, seconds);
    return this;
  }

  override destroy(): this {
    this.pointer.destroy();
    return super.destroy();
  }

  private updatePaddle(
    state: BreakoutState,
    keyboard: KeyboardComponent,
    seconds: number,
  ): void {
    let axis = 0;
    if (keyboard.isPressed('MoveLeft')) axis -= 1;
    if (keyboard.isPressed('MoveRight')) axis += 1;

    if (axis !== 0) {
      state.paddle.transform.x += axis * PADDLE.speed * seconds;
      this.pointer.preferKeyboard();
    } else if (this.pointer.pointerActive) {
      state.paddle.transform.x = this.pointer.pointerWorldX;
    }

    state.paddle.transform.x = clamp(
      state.paddle.transform.x,
      PLAYFIELD.left + PADDLE.width / 2,
      PLAYFIELD.right - PADDLE.width / 2,
    );
  }

  private attachBallToPaddle(state: BreakoutState): void {
    state.ball.transform.x = state.paddle.transform.x;
    state.ball.transform.y =
      PADDLE.y + PADDLE.height / 2 + BALL.radius + 4;
  }

  private launchBall(state: BreakoutState): void {
    state.phase = 'playing';
    state.velocityX = BALL.speed * 0.62;
    state.velocityY = BALL.speed * 0.78;
    this.updateHud(state, '击碎所有砖块');
  }

  private simulateBall(
    state: BreakoutState,
    world: World,
    seconds: number,
  ): void {
    const ball = state.ball.transform;
    const previousX = ball.x;
    const previousY = ball.y;

    ball.x += state.velocityX * seconds;
    ball.y += state.velocityY * seconds;

    this.collideWithWalls(state);
    if (ball.y - BALL.radius < PLAYFIELD.bottom) {
      this.loseLife(state);
      return;
    }

    this.collideWithPaddle(state);
    this.collideWithBricks(state, world, previousX, previousY);

    if (state.bricks.every((brick) => !brick.active)) {
      state.phase = 'won';
      this.updateHud(state, '胜利！按空格、点击画面或按 R 再来一局');
    }
  }

  private collideWithWalls(state: BreakoutState): void {
    const ball = state.ball.transform;
    if (ball.x - BALL.radius < PLAYFIELD.left) {
      ball.x = PLAYFIELD.left + BALL.radius;
      state.velocityX = Math.abs(state.velocityX);
    } else if (ball.x + BALL.radius > PLAYFIELD.right) {
      ball.x = PLAYFIELD.right - BALL.radius;
      state.velocityX = -Math.abs(state.velocityX);
    }

    if (ball.y + BALL.radius > PLAYFIELD.top) {
      ball.y = PLAYFIELD.top - BALL.radius;
      state.velocityY = -Math.abs(state.velocityY);
    }
  }

  private collideWithPaddle(state: BreakoutState): void {
    const ball = state.ball.transform;
    const paddle = state.paddle.transform;
    if (
      state.velocityY >= 0 ||
      !circleOverlapsRect(
        ball.x,
        ball.y,
        BALL.radius,
        paddle.x,
        PADDLE.y,
        PADDLE.width,
        PADDLE.height,
      )
    ) {
      return;
    }

    ball.y = PADDLE.y + PADDLE.height / 2 + BALL.radius;

    // 击中球拍边缘时反射角更大，玩家可以主动控制球路。
    const hit = clamp(
      (ball.x - paddle.x) / (PADDLE.width / 2),
      -1,
      1,
    );
    const angle = hit * Math.PI * 0.36;
    state.velocityX = Math.sin(angle) * BALL.speed;
    state.velocityY = Math.cos(angle) * BALL.speed;
  }

  private collideWithBricks(
    state: BreakoutState,
    world: World,
    previousX: number,
    previousY: number,
  ): void {
    const ball = state.ball.transform;

    for (const brick of state.bricks) {
      if (
        !brick.active ||
        !circleOverlapsRect(
          ball.x,
          ball.y,
          BALL.radius,
          brick.transform.x,
          brick.transform.y,
          brick.width,
          brick.height,
        )
      ) {
        continue;
      }

      brick.active = false;
      world.removeEntity(brick.entity);
      state.score += BRICKS.score;

      // 根据上一位置判断球从侧面还是上下进入砖块。
      const halfWidth = brick.width / 2;
      const halfHeight = brick.height / 2;
      const enteredFromSide =
        previousX + BALL.radius <= brick.transform.x - halfWidth ||
        previousX - BALL.radius >= brick.transform.x + halfWidth;
      const enteredVertically =
        previousY + BALL.radius <= brick.transform.y - halfHeight ||
        previousY - BALL.radius >= brick.transform.y + halfHeight;

      if (enteredFromSide && !enteredVertically) {
        state.velocityX *= -1;
      } else {
        state.velocityY *= -1;
      }

      // 回到碰撞前位置，避免下一帧仍在砖块内部。
      ball.x = previousX;
      ball.y = previousY;
      this.updateHud(state, '继续！');
      break;
    }
  }

  private loseLife(state: BreakoutState): void {
    state.lives -= 1;
    if (state.lives <= 0) {
      state.phase = 'lost';
      this.updateHud(state, '游戏结束，按空格、点击画面或按 R 重开');
      return;
    }

    state.phase = 'ready';
    this.updateHud(state, '空格或点击画面继续');
  }

  private resetGame(state: BreakoutState, world: World): void {
    state.score = 0;
    state.lives = 3;
    state.phase = 'ready';
    state.velocityX = BALL.speed * 0.62;
    state.velocityY = BALL.speed * 0.78;
    state.paddle.transform.x = 0;

    for (const brick of state.bricks) {
      if (!brick.active && !world.hasEntity(brick.entity)) {
        world.addEntity(brick.entity);
      }
      brick.active = true;
    }

    this.attachBallToPaddle(state);
    this.updateHud(
      state,
      'A/D 或方向键移动，空格或点击画面发球',
    );
  }

  private updateHud(state: BreakoutState, message: string): void {
    state.hud.score.textContent = `得分 ${state.score}`;
    state.hud.lives.textContent = `生命 ${state.lives}`;
    state.hud.message.textContent = message;
  }
}
```

### 8.3 这里用到了哪些引擎行为

- `delta` 单位是毫秒，移动前转换成秒。
- `Transform2D.x/y` 改变后，渲染系统会在后续帧使用新变换。
- `world.removeEntity()` 让砖块离开更新和渲染查询，但不销毁它。
- `world.addEntity()` 可以在重开时恢复未销毁的砖块。
- `System.destroy()` 中释放 Pointer 监听，避免切换场景后旧游戏继续响应输入。

永久删除对象时使用 `world.destroyEntity()` 或 `entity.destroy()`。已经销毁的 Entity 不能重新加入 World。

## 9. 模块七：组装相机、输入、状态和系统

所有模块已经完成，最后的入口只做组装。创建 `src/main.ts`：

```ts
import {
  Camera2D,
  Entity,
  HaiyueEngine,
} from '@haiyue/engine';
import { KeyboardComponent } from '@haiyue/engine/components';
import { InputMap } from '@haiyue/engine/input';
import { buildActors } from './game/actors';
import { BreakoutInput } from './game/BreakoutInput';
import { BreakoutState } from './game/BreakoutState';
import { BreakoutSystem } from './game/BreakoutSystem';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './game/config';

function requiredElement<T extends Element>(
  selector: string,
): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`缺少页面元素：${selector}`);
  return element;
}

async function main(): Promise<void> {
  const canvas = requiredElement<HTMLCanvasElement>('#game');
  const score = requiredElement<HTMLElement>('#score');
  const lives = requiredElement<HTMLElement>('#lives');
  const message = requiredElement<HTMLElement>('#message');

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.025, g: 0.055, b: 0.11, a: 1 },
  });
  await engine.init();

  const cameraEntity = new Entity('Camera');
  const camera = new Camera2D({
    designWidth: DESIGN_WIDTH,
    designHeight: DESIGN_HEIGHT,
    viewportMode: 'fit',
  });
  cameraEntity.addComponent(camera);

  const scene = engine.createScene({
    name: 'Breakout',
    camera: { type: '2d', entity: cameraEntity },
    render3D: false,
    render2D: { loadOp: 'clear' },
    pipelineLabel: 'Breakout.render',
  });

  const actors = buildActors(scene);

  KeyboardComponent.setInputMap(new InputMap({
    MoveLeft: ['KeyA', 'ArrowLeft'],
    MoveRight: ['KeyD', 'ArrowRight'],
    Launch: ['Space'],
    Restart: ['KeyR'],
  }));

  const gameController = new Entity('GameController');
  gameController.addComponent(new KeyboardComponent());
  gameController.addComponent(new BreakoutState(
    actors.paddle,
    actors.ball,
    actors.bricks,
    { score, lives, message },
  ));
  scene.add(gameController);

  const pointer = new BreakoutInput(canvas, camera);
  scene.addSystem(new BreakoutSystem(pointer), false);

  engine.switchScene(scene);
  engine.run();
}

void main();
```

至此，前面创建的七个文件共同构成完整游戏，而 `main.ts` 只保留以下产品级流程：

```text
初始化 Engine
  ↓
创建 Camera2D 和 Scene
  ↓
buildActors() 构建画面
  ↓
配置 InputMap
  ↓
创建状态 Component
  ↓
安装 BreakoutSystem
  ↓
switchScene() + run()
```

`Camera2D` 的 `designWidth`、`designHeight` 和 `viewportMode: 'fit'` 会让设计区域在不同宽高比下完整可见。`engine.run()` 会自动更新 active scene，不要再从 `engine.on('update')` 手工调用 `scene.update()`。

## 10. 验收完整游戏

运行后按需求逐项验证：

- [ ] A/D 和方向键能连续移动球拍；
- [ ] 鼠标或触摸移动能控制球拍；
- [ ] 空格和点击只触发一次发球；
- [ ] 球不会持续卡在墙、球拍或砖块中；
- [ ] 每块砖只计分一次；
- [ ] 掉球后生命减一，球重新回到球拍；
- [ ] 清空砖块显示胜利，三次掉球显示失败；
- [ ] R 和结束后的空格/点击能够恢复全部砖块；
- [ ] 改变浏览器窗口尺寸后游戏仍完整可见；
- [ ] 销毁或切换场景后旧 Pointer 监听不再生效。

## 11. 手写碰撞的适用边界

本例的圆与 AABB 检测适合低速、轴对齐的简单玩法。`Math.min(delta, 32)` 只能降低切换标签页后的大步长问题，不是完整的防穿透方案。

出现以下需求时，应该进一步使用固定时间步、swept collision，或切换到 [`Physics2DSystem`](./physics-2d.md)：

- 球速很高；
- 障碍物会旋转；
- 需要刚体质量、摩擦、关节或连续碰撞；
- 需要稳定回放或更复杂的碰撞层。

## 12. “游戏脚本”与 `ScriptComponent`

本教程把 `BreakoutSystem` 作为类型安全的游戏脚本。它可以正常 import、重构、单元测试，并在构建期检查。代码优先项目中的复杂玩法逻辑优先使用这种形式。

编辑器中由场景资源保存、需要热重载的短脚本可以使用 `ScriptComponent`：

```ts
import { ScriptComponent } from '@haiyue/engine/components';

ScriptComponent.enableTrustedProject({
  capabilities: ['read', 'input', 'debug'],
  errorPolicy: 'disable-script',
});
```

`ScriptComponent` 在页面 JavaScript realm 中运行，不是安全沙箱。不要把整个 `BreakoutSystem` 复制成一个巨大字符串；可以让编辑器脚本调用普通 TypeScript 模块公开的游戏服务。生命周期、热重载和资源清理见[项目脚本运行时](./script-runtime.md)。

## 13. 下一步扩展

完成基础版本后，可以继续按模块扩展：

1. 在 `BreakoutState` 中加入关卡编号和连击状态。
2. 在 `actors.ts` 中从 JSON 生成不同关卡。
3. 给砖块增加耐久 Component，并修改 `Material2D.color` 表示受损。
4. 新增 `PowerUpSystem`，让砖块掉落多球或加宽球拍道具。
5. 使用 `Physics2DSystem` 替换 `collision.ts` 和手写反射。
6. 加入粒子、音效、暂停菜单和固定时间步回放。

仓库内的相关可运行示例：

- [`examples/shapes2d`](../../examples/shapes2d/)：2D Geometry、Material、混合与变换；
- [`examples/box2d-collision`](../../examples/box2d-collision/)：2D 刚体与碰撞；
- [`examples/box2d-mouse-drag`](../../examples/box2d-mouse-drag/)：Pointer 坐标转换、拾取和 Mouse Joint；
- [`games/billiards`](../../../Games/games/billiards/)：更完整的 2D 物理游戏循环。
