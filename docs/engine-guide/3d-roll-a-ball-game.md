# 3D 小游戏实战：从需求拆解到完成水晶收集

本教程通过代码完成一个简单的 3D 水晶收集游戏：玩家控制小球在场地中移动，绕过障碍，收集全部水晶后获胜。

它没有外部模型、贴图和复杂物理，却能覆盖常见 3D 游戏 API：

- 3D Scene、透视相机和 OrbitControl；
- Entity、Component、System 和逐帧更新；
- Geometry3D、Mesh3D、Transform3D；
- PBR 材质、环境光、方向光和阴影；
- InputMap 与 KeyboardComponent；
- 简单碰撞、实体移除与恢复；
- 相机跟随、计分、胜利和重开。

这类游戏通常也叫 Roll-a-Ball。相比第一人称或平台跳跃，它不需要鼠标锁定、角色控制器、重力、跳跃和动画状态机；相比只展示静态模型，它又包含完整的输入、规则和反馈循环，适合作为第一个 3D 游戏实战。

## 1. 从游戏需求拆出模块

### 1.1 验收需求

先明确最终要完成什么：

1. W/A/S/D 和方向键控制小球在地面移动。
2. 对角移动不能比单轴移动更快。
3. 小球不能离开场地，也不能穿过障碍。
4. 接触水晶后，水晶消失且分数增加。
5. 水晶持续旋转和上下浮动。
6. 相机平滑跟随小球，鼠标可以旋转和缩放视角。
7. 收集全部水晶后显示胜利。
8. 按 R 恢复小球、水晶和分数。
9. 场景使用 PBR 材质、环境光和带阴影的方向光。

### 1.2 模块划分

按照变化原因，而不是代码行数拆分：

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `config.ts` | 场地尺寸、速度、障碍和水晶布局 | 创建 Entity |
| `collision.ts` | XZ 平面的圆与矩形碰撞 | 移除水晶、计分 |
| `actors.ts` | 创建地面、围栏、玩家、障碍和水晶 | 输入与游戏流程 |
| `lighting.ts` | 建立 PBR 光照与阴影 | 玩法逻辑 |
| `CollectGameState.ts` | 保存一局游戏的可变状态 | 逐帧调度 |
| `CollectGameSystem.ts` | 移动、碰撞、收集、动画和相机跟随 | 初始化 Engine |
| `main.ts` | 创建 Scene 并组装所有模块 | 具体规则实现 |

最终目录：

```text
roll-a-ball/
├── index.html
└── src/
    ├── main.ts
    └── game/
        ├── config.ts
        ├── collision.ts
        ├── actors.ts
        ├── lighting.ts
        ├── CollectGameState.ts
        └── CollectGameSystem.ts
```

模块依赖保持单向：

```text
main
├── actors ── config
├── lighting
├── CollectGameState ── actors
└── CollectGameSystem
    ├── config
    ├── collision
    └── CollectGameState
```

## 2. 建立 Canvas 和 HUD

3D 场景由 WebGPU 渲染，计分与提示使用 DOM。创建 `index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Haiyue Roll-a-Ball</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; }
      body {
        overflow: hidden;
        color: #eef6ff;
        background: #07101c;
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
        inset: 18px 20px auto;
        display: flex;
        justify-content: space-between;
        pointer-events: none;
        text-shadow: 0 2px 10px #000;
      }
      #message {
        position: fixed;
        left: 50%;
        bottom: 22px;
        transform: translateX(-50%);
        color: #bed1e8;
        pointer-events: none;
      }
    </style>
  </head>
  <body>
    <canvas id="game"></canvas>
    <div id="hud">
      <span id="score">水晶 0 / 8</span>
      <span>拖动旋转视角 · 滚轮缩放</span>
    </div>
    <div id="message">W/A/S/D 或方向键移动，R 重开</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Canvas 使用 CSS 填满窗口，实际渲染尺寸和 Camera aspect 由引擎更新。`touch-action: none` 避免浏览器把相机拖动解释成页面手势。

## 3. 模块一：定义场地和关卡数据

游戏使用 Y 向上的右手坐标系。玩家只在 XZ 平面移动：

```text
             -Z / 前
                ↑
       ┌─────────────────┐
       │  ◆       █      │
 -X ←  │      ●          │  → +X
       │  █          ◆   │
       └─────────────────┘
                ↓
              +Z / 后
```

创建 `src/game/config.ts`：

```ts
export type PointXZ = Readonly<{
  x: number;
  z: number;
}>;

export interface ObstacleDefinition extends PointXZ {
  width: number;
  depth: number;
  height: number;
}

export const ARENA = {
  minX: -8,
  maxX: 8,
  minZ: -6,
  maxZ: 6,
} as const;

export const PLAYER = {
  start: { x: 0, z: 4.5 },
  radius: 0.55,
  speed: 5,
} as const;

export const CRYSTAL = {
  radius: 0.38,
  baseY: 0.72,
  bobHeight: 0.14,
  bobSpeed: 2.2,
  rotationSpeed: 1.8,
} as const;

export const OBSTACLES: readonly ObstacleDefinition[] = [
  { x: -3.4, z: 1.2, width: 1.4, depth: 3.2, height: 1.4 },
  { x: 0, z: -0.8, width: 3.4, depth: 1.2, height: 1.1 },
  { x: 3.8, z: 1.4, width: 1.2, depth: 3, height: 1.8 },
];

export const CRYSTAL_POSITIONS: readonly PointXZ[] = [
  { x: -6.5, z: 4.2 },
  { x: -5.8, z: -4.4 },
  { x: -2.1, z: 3.5 },
  { x: -2.2, z: -3.7 },
  { x: 2.2, z: 3.8 },
  { x: 2.5, z: -3.5 },
  { x: 6.3, z: 4.1 },
  { x: 6.4, z: -4.2 },
];
```

场地规则与渲染分离后，可以直接修改数组设计新关卡，也可以在后续把这些定义换成 JSON。

## 4. 模块二：实现可测试的简单碰撞

玩家在玩法层是一个圆，障碍在 XZ 平面是轴对齐矩形。创建 `src/game/collision.ts`：

```ts
import type { ObstacleDefinition } from './config';

export function clamp(
  value: number,
  min: number,
  max: number,
): number {
  return Math.max(min, Math.min(max, value));
}

export function circleOverlapsBoxXZ(
  circleX: number,
  circleZ: number,
  radius: number,
  box: ObstacleDefinition,
): boolean {
  const nearestX = clamp(
    circleX,
    box.x - box.width / 2,
    box.x + box.width / 2,
  );
  const nearestZ = clamp(
    circleZ,
    box.z - box.depth / 2,
    box.z + box.depth / 2,
  );
  const dx = circleX - nearestX;
  const dz = circleZ - nearestZ;
  return dx * dx + dz * dz <= radius * radius;
}

export function circlesOverlapXZ(
  ax: number,
  az: number,
  ar: number,
  bx: number,
  bz: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  const radius = ar + br;
  return dx * dx + dz * dz <= radius * radius;
}
```

这个模块不依赖 Entity 或 Transform，可以用普通单元测试验证相切、重叠和分离情况。这里只回答“是否碰撞”，至于停止移动还是增加分数，由游戏 System 决定。

## 5. 模块三：用 Entity 组合场景对象

每个可见对象由 Entity、`CartesianTransform3D` 和 `Mesh3D` 组合：

```text
Player Entity
├── CartesianTransform3D
└── Mesh3D
    ├── Geometry3D
    └── PbrMaterial
```

创建 `src/game/actors.ts`：

```ts
import {
  CartesianTransform3D,
  Entity,
  Geometry3D,
  Mesh3D,
  PbrMaterial,
  Scene,
  createBox3D,
  createPlane3D,
  createSphere3D,
} from '@haiyue/engine';
import {
  ARENA,
  CRYSTAL,
  CRYSTAL_POSITIONS,
  OBSTACLES,
  PLAYER,
  type ObstacleDefinition,
} from './config';

export interface Actor3D {
  entity: Entity;
  transform: CartesianTransform3D;
}

export interface ObstacleActor extends Actor3D {
  definition: ObstacleDefinition;
}

export interface CrystalActor extends Actor3D {
  active: boolean;
  phase: number;
}

export interface CollectGameActors {
  player: Actor3D;
  obstacles: ObstacleActor[];
  crystals: CrystalActor[];
}

function createActor(
  name: string,
  geometry: Geometry3D,
  material: PbrMaterial,
  position: [number, number, number],
  rotation?: [number, number, number],
): Actor3D {
  const entity = new Entity(name);
  const transform = new CartesianTransform3D({
    position,
    ...(rotation ? { rotation } : {}),
  });
  entity.addComponent(transform);
  entity.addComponent(new Mesh3D(geometry, material));
  return { entity, transform };
}

export function buildActors(scene: Scene): CollectGameActors {
  const groundMaterial = new PbrMaterial({
    baseColor: [0.12, 0.25, 0.23, 1],
    metallic: 0.05,
    roughness: 0.82,
  });
  const ground = createActor(
    'Ground',
    createPlane3D({
      width: ARENA.maxX - ARENA.minX,
      height: ARENA.maxZ - ARENA.minZ,
      normal: 'y',
    }),
    groundMaterial,
    [0, 0, 0],
  );
  scene.add(ground.entity);

  const wallMaterial = new PbrMaterial({
    baseColor: [0.18, 0.32, 0.46, 1],
    metallic: 0.15,
    roughness: 0.52,
  });
  const wallHeight = 0.6;
  const wallThickness = 0.35;
  const arenaWidth = ARENA.maxX - ARENA.minX;
  const arenaDepth = ARENA.maxZ - ARENA.minZ;
  const walls = [
    createActor(
      'NorthWall',
      createBox3D({
        width: arenaWidth + wallThickness * 2,
        height: wallHeight,
        depth: wallThickness,
      }),
      wallMaterial,
      [0, wallHeight / 2, ARENA.minZ - wallThickness / 2],
    ),
    createActor(
      'SouthWall',
      createBox3D({
        width: arenaWidth + wallThickness * 2,
        height: wallHeight,
        depth: wallThickness,
      }),
      wallMaterial,
      [0, wallHeight / 2, ARENA.maxZ + wallThickness / 2],
    ),
    createActor(
      'WestWall',
      createBox3D({
        width: wallThickness,
        height: wallHeight,
        depth: arenaDepth,
      }),
      wallMaterial,
      [ARENA.minX - wallThickness / 2, wallHeight / 2, 0],
    ),
    createActor(
      'EastWall',
      createBox3D({
        width: wallThickness,
        height: wallHeight,
        depth: arenaDepth,
      }),
      wallMaterial,
      [ARENA.maxX + wallThickness / 2, wallHeight / 2, 0],
    ),
  ];
  for (const wall of walls) scene.add(wall.entity);

  const obstacleMaterial = new PbrMaterial({
    baseColor: [0.52, 0.25, 0.16, 1],
    metallic: 0.12,
    roughness: 0.6,
  });
  const obstacles = OBSTACLES.map((definition, index) => {
    const actor = createActor(
      `Obstacle-${index}`,
      createBox3D({
        width: definition.width,
        height: definition.height,
        depth: definition.depth,
      }),
      obstacleMaterial,
      [definition.x, definition.height / 2, definition.z],
    );
    scene.add(actor.entity);
    return { ...actor, definition };
  });

  const player = createActor(
    'Player',
    createSphere3D({
      radius: PLAYER.radius,
      widthSegments: 32,
      heightSegments: 20,
    }),
    new PbrMaterial({
      baseColor: [0.18, 0.58, 1, 1],
      metallic: 0.62,
      roughness: 0.22,
      clearcoatFactor: 0.65,
      clearcoatRoughnessFactor: 0.15,
    }),
    [PLAYER.start.x, PLAYER.radius, PLAYER.start.z],
  );
  scene.add(player.entity);

  const crystalGeometry = createBox3D({
    width: 0.5,
    height: 0.8,
    depth: 0.5,
  });
  const crystalMaterial = new PbrMaterial({
    baseColor: [0.2, 1, 0.78, 1],
    emissiveFactor: [0.02, 0.35, 0.2],
    metallic: 0.35,
    roughness: 0.18,
  });
  const crystals = CRYSTAL_POSITIONS.map((position, index) => {
    const actor = createActor(
      `Crystal-${index}`,
      crystalGeometry,
      crystalMaterial,
      [position.x, CRYSTAL.baseY, position.z],
      [Math.PI / 4, 0, Math.PI / 4],
    );
    scene.add(actor.entity);
    return {
      ...actor,
      active: true,
      phase: index * 0.7,
    };
  });

  return { player, obstacles, crystals };
}
```

这里复用了水晶 Geometry 和 Material。障碍尺寸不同，所以分别创建 Geometry，但共享 Material。修改共享水晶 Material 会同时改变全部水晶。

写完此模块后，场景中已经有完整静态关卡，但尚不能移动。

## 6. 模块四：建立 PBR 光照和阴影

PBR 材质需要直接光和环境光。创建 `src/game/lighting.ts`：

```ts
import {
  DirectionalLight,
  Entity,
  EnvironmentLight,
  Scene,
} from '@haiyue/engine';

export function addLighting(scene: Scene): void {
  const sun = new Entity('Sun');
  sun.addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.4],
    color: [1, 0.94, 0.82],
    intensity: 2.8,
    castShadow: true,
    shadow: {
      mapSize: 1024,
      extent: 20,
      near: 0.1,
      far: 40,
      bias: 0.0012,
      normalBias: 0.02,
    },
  }));
  scene.add(sun);

  const environment = new Entity('Environment');
  environment.addComponent(new EnvironmentLight({
    intensity: 0.72,
    diffuseColor: [0.12, 0.24, 0.38],
    specularColor: [0.62, 0.82, 1],
  }));
  scene.add(environment);
}
```

`DirectionalLight` 提供有方向的主光和 shadow map，`EnvironmentLight` 在没有环境贴图时使用颜色作为 IBL fallback。后者避免背光面完全变黑。

阴影的 `extent` 应覆盖实际游戏区域，而不是无条件设得很大；范围越大，每个 shadow texel 覆盖的世界空间也越大。

## 7. 模块五：用 Component 保存运行状态

创建 `src/game/CollectGameState.ts`：

```ts
import {
  Component,
  SphericalTransform3D,
} from '@haiyue/engine';
import type {
  Actor3D,
  CrystalActor,
  ObstacleActor,
} from './actors';

export interface CollectGameHud {
  score: HTMLElement;
  message: HTMLElement;
}

export class CollectGameState extends Component {
  phase: 'playing' | 'won' = 'playing';
  collected = 0;
  rollX = 0;
  rollZ = 0;

  constructor(
    readonly player: Actor3D,
    readonly obstacles: readonly ObstacleActor[],
    readonly crystals: readonly CrystalActor[],
    readonly cameraOrbit: SphericalTransform3D,
    readonly hud: CollectGameHud,
  ) {
    super('CollectGameState');
  }
}
```

State 保存“一局游戏现在是什么状态”，不负责每帧更新。相机 Transform 也由 State 持有引用，因为玩法 System 需要更新它的跟随目标。

## 8. 模块六：实现移动、收集与相机跟随

### 8.1 一帧的执行顺序

```text
读取 Restart
  ↓
读取并归一化移动输入
  ↓
分别尝试 X 和 Z 移动
  ↓
更新小球 Transform 和滚动效果
  ↓
检测并移除水晶
  ↓
更新水晶动画
  ↓
平滑更新相机 target
```

X、Z 分轴尝试移动，可以让玩家沿着障碍边缘滑动。如果把两个轴一次性拒绝，斜向碰到墙时会突然完全停止。

创建 `src/game/CollectGameSystem.ts`：

```ts
import {
  Entity,
  System,
  World,
} from '@haiyue/engine';
import { KeyboardComponent } from '@haiyue/engine/components';
import {
  ARENA,
  CRYSTAL,
  PLAYER,
} from './config';
import {
  circleOverlapsBoxXZ,
  circlesOverlapXZ,
  clamp,
} from './collision';
import { CollectGameState } from './CollectGameState';

export class CollectGameSystem extends System {
  constructor() {
    super(
      { all: [CollectGameState, KeyboardComponent] },
      undefined,
      'CollectGameSystem',
    );
  }

  override handle(
    entity: Entity,
    time: number,
    delta: number,
    world: World,
  ): this {
    const state = entity.getComponent(CollectGameState);
    const keyboard = entity.getComponent(KeyboardComponent);
    if (!state || !keyboard) return this;

    // delta 单位是毫秒。限制大步长，降低切回标签页后的穿透。
    const seconds = Math.min(delta, 32) / 1000;

    if (keyboard.wasPressed('Restart')) {
      this.reset(state, world);
    }

    if (state.phase === 'playing') {
      this.movePlayer(state, keyboard, seconds);
      this.collectCrystals(state, world);
    }

    this.animateCrystals(state, time / 1000);
    this.followPlayer(state, seconds);
    return this;
  }

  private movePlayer(
    state: CollectGameState,
    keyboard: KeyboardComponent,
    seconds: number,
  ): void {
    let inputX = 0;
    let inputZ = 0;
    if (keyboard.isPressed('MoveLeft')) inputX -= 1;
    if (keyboard.isPressed('MoveRight')) inputX += 1;
    if (keyboard.isPressed('MoveForward')) inputZ -= 1;
    if (keyboard.isPressed('MoveBackward')) inputZ += 1;

    const length = Math.hypot(inputX, inputZ);
    if (length > 1) {
      inputX /= length;
      inputZ /= length;
    }

    const transform = state.player.transform;
    let x = transform.position[0] ?? 0;
    let z = transform.position[2] ?? 0;
    const moveX = inputX * PLAYER.speed * seconds;
    const moveZ = inputZ * PLAYER.speed * seconds;

    const candidateX = clamp(
      x + moveX,
      ARENA.minX + PLAYER.radius,
      ARENA.maxX - PLAYER.radius,
    );
    if (this.canOccupy(state, candidateX, z)) x = candidateX;

    const candidateZ = clamp(
      z + moveZ,
      ARENA.minZ + PLAYER.radius,
      ARENA.maxZ - PLAYER.radius,
    );
    if (this.canOccupy(state, x, candidateZ)) z = candidateZ;

    transform.setPosition(x, PLAYER.radius, z);

    // 用移动距离近似球的滚动。复杂表面应由物理角速度驱动。
    state.rollX += moveZ / PLAYER.radius;
    state.rollZ -= moveX / PLAYER.radius;
    transform.setRotation(state.rollX, 0, state.rollZ);
  }

  private canOccupy(
    state: CollectGameState,
    x: number,
    z: number,
  ): boolean {
    return state.obstacles.every((obstacle) =>
      !circleOverlapsBoxXZ(
        x,
        z,
        PLAYER.radius,
        obstacle.definition,
      ),
    );
  }

  private collectCrystals(
    state: CollectGameState,
    world: World,
  ): void {
    const x = state.player.transform.position[0] ?? 0;
    const z = state.player.transform.position[2] ?? 0;

    for (const crystal of state.crystals) {
      if (!crystal.active) continue;
      const crystalX = crystal.transform.position[0] ?? 0;
      const crystalZ = crystal.transform.position[2] ?? 0;
      if (!circlesOverlapXZ(
        x,
        z,
        PLAYER.radius,
        crystalX,
        crystalZ,
        CRYSTAL.radius,
      )) {
        continue;
      }

      crystal.active = false;
      world.removeEntity(crystal.entity);
      state.collected += 1;
      this.updateHud(state);
    }

    if (state.collected === state.crystals.length) {
      state.phase = 'won';
      state.hud.message.textContent = '全部收集完成！按 R 再来一局';
    }
  }

  private animateCrystals(
    state: CollectGameState,
    timeSeconds: number,
  ): void {
    for (const crystal of state.crystals) {
      if (!crystal.active) continue;
      const x = crystal.transform.position[0] ?? 0;
      const z = crystal.transform.position[2] ?? 0;
      const y = CRYSTAL.baseY +
        Math.sin(
          timeSeconds * CRYSTAL.bobSpeed + crystal.phase,
        ) * CRYSTAL.bobHeight;
      crystal.transform.setPosition(x, y, z);
      crystal.transform.setRotation(
        Math.PI / 4,
        timeSeconds * CRYSTAL.rotationSpeed + crystal.phase,
        Math.PI / 4,
      );
    }
  }

  private followPlayer(
    state: CollectGameState,
    seconds: number,
  ): void {
    const player = state.player.transform.position;
    const target = state.cameraOrbit.target;
    const alpha = 1 - Math.exp(-6 * seconds);
    state.cameraOrbit.setTarget(
      (target[0] ?? 0) +
        ((player[0] ?? 0) - (target[0] ?? 0)) * alpha,
      0.35,
      (target[2] ?? 0) +
        ((player[2] ?? 0) - (target[2] ?? 0)) * alpha,
    );
  }

  private reset(
    state: CollectGameState,
    world: World,
  ): void {
    state.phase = 'playing';
    state.collected = 0;
    state.rollX = 0;
    state.rollZ = 0;
    state.player.transform.setPosition(
      PLAYER.start.x,
      PLAYER.radius,
      PLAYER.start.z,
    );
    state.player.transform.setRotation(0, 0, 0);
    state.cameraOrbit.setTarget(
      PLAYER.start.x,
      0.35,
      PLAYER.start.z,
    );

    for (const crystal of state.crystals) {
      if (!crystal.active && !world.hasEntity(crystal.entity)) {
        world.addEntity(crystal.entity);
      }
      crystal.active = true;
      crystal.transform.setPosition(
        crystal.transform.position[0] ?? 0,
        CRYSTAL.baseY,
        crystal.transform.position[2] ?? 0,
      );
    }

    state.hud.message.textContent =
      'W/A/S/D 或方向键移动，R 重开';
    this.updateHud(state);
  }

  private updateHud(state: CollectGameState): void {
    state.hud.score.textContent =
      `水晶 ${state.collected} / ${state.crystals.length}`;
  }
}
```

World 会先更新 Component，再运行 System，因此在 System 中读取 `wasPressed('Restart')` 能得到正确的按键边沿。不要在 `engine.on('update')` 中读取当帧 `wasPressed()`。

`world.removeEntity()` 只让水晶离开 World，所以它不再被渲染，但 Entity 和组件仍可在重开时恢复。永久释放使用 `world.destroyEntity()` 或 `entity.destroy()`。

## 9. 模块七：创建 Scene 并组装完整游戏

创建 `src/main.ts`：

```ts
import {
  HaiyueEngine,
  Entity,
  OrbitControl,
  SphericalTransform3D,
} from '@haiyue/engine';
import { KeyboardComponent } from '@haiyue/engine/components';
import { InputMap } from '@haiyue/engine/input';
import { buildActors } from './game/actors';
import { addLighting } from './game/lighting';
import { CollectGameState } from './game/CollectGameState';
import { CollectGameSystem } from './game/CollectGameSystem';

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`缺少页面元素：${selector}`);
  return element;
}

async function main(): Promise<void> {
  const canvas = requiredElement<HTMLCanvasElement>('#game');
  const score = requiredElement<HTMLElement>('#score');
  const message = requiredElement<HTMLElement>('#message');

  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'batched',
    msaaSamples: 4,
    clearColor: { r: 0.025, g: 0.055, b: 0.1, a: 1 },
  });
  await engine.init();

  const scene = engine.createScene({
    name: 'Crystal Collector',
    camera: {
      type: '3d',
      camera3D: {
        type: 'perspective',
        fov: Math.PI / 4,
        near: 0.1,
        far: 100,
      },
      orbit: {
        radius: 16,
        theta: 0,
        phi: Math.PI * 0.3,
        target: [0, 0.35, 4.5],
      },
    },
    render3D: { renderProfile: 'batched' },
    render2D: false,
    gui: false,
    pipelineLabel: 'CrystalCollector.render',
  });

  const cameraOrbit =
    scene.cameraEntity.getComponent(SphericalTransform3D);
  if (!cameraOrbit) {
    throw new Error('3D Scene 缺少 SphericalTransform3D');
  }

  // OrbitControl 是 System。交给 Scene 后，销毁 Scene 会自动解除监听。
  const orbitControl = new OrbitControl(canvas, cameraOrbit, {
    minRadius: 10,
    maxRadius: 24,
    minPhi: Math.PI * 0.18,
    maxPhi: Math.PI * 0.46,
    enablePan: false,
    rotateSpeed: 0.55,
    zoomSpeed: 0.65,
  });
  scene.addSystem(orbitControl, false);

  addLighting(scene);
  const actors = buildActors(scene);

  KeyboardComponent.setInputMap(new InputMap({
    MoveForward: ['KeyW', 'ArrowUp'],
    MoveBackward: ['KeyS', 'ArrowDown'],
    MoveLeft: ['KeyA', 'ArrowLeft'],
    MoveRight: ['KeyD', 'ArrowRight'],
    Restart: ['KeyR'],
  }));

  const controller = new Entity('GameController');
  controller.addComponent(new KeyboardComponent());
  controller.addComponent(new CollectGameState(
    actors.player,
    actors.obstacles,
    actors.crystals,
    cameraOrbit,
    { score, message },
  ));
  scene.add(controller);
  scene.addSystem(new CollectGameSystem(), false);

  engine.switchScene(scene);
  engine.run();
}

void main();
```

入口文件只做组合：

```text
初始化 Engine
  ↓
创建 3D Scene 和相机
  ↓
安装 OrbitControl
  ↓
添加灯光和场景对象
  ↓
配置 InputMap
  ↓
添加 State Component 与玩法 System
  ↓
switchScene() + run()
```

`renderProfile: 'batched'` 是不依赖 WebGPU 可选 feature 的保守 3D 产品路径。`msaaSamples: 4` 用于改善几何边缘；资源较紧张的设备可以降为 1。

`engine.run()` 会自动更新 active scene，不要再从 `engine.on('update')` 手工执行 `scene.update()`。

## 10. 验收游戏

逐项检查：

- [ ] W/A/S/D 和方向键可以移动；
- [ ] 对角速度与单轴速度一致；
- [ ] 玩家不会越过围栏或穿过障碍；
- [ ] 玩家能沿障碍边缘滑动；
- [ ] 水晶持续旋转和浮动；
- [ ] 接触水晶后只计分一次，且实体消失；
- [ ] 相机平滑跟随，拖动和滚轮仍可改变视角；
- [ ] 收集全部水晶显示胜利；
- [ ] 按 R 恢复所有水晶与初始位置；
- [ ] 改变窗口尺寸后透视比例正确；
- [ ] 切换或销毁 Scene 后 OrbitControl 不再响应。

## 11. 当前碰撞方案的边界

本教程有意使用 XZ 平面的简单碰撞，以便看清游戏循环。它适合固定地面、轴对齐障碍和低速移动。

出现以下需求时，应改用 [`Physics3DSystem`](./physics-3d.md)：

- 重力、斜坡、跳跃和真正滚动；
- 旋转或移动障碍；
- 质量、摩擦、反弹、力和冲量；
- 高速连续碰撞；
- 刚体、关节或触发器。

切换物理后，`actors.ts` 仍负责创建外观，`CollectGameState` 仍负责分数，主要替换的是 `collision.ts` 和 `CollectGameSystem.movePlayer()`。这正是按职责拆模块的价值。

## 12. 下一步扩展

基础版本完成后，可以逐步增加：

1. 把 `config.ts` 的布局改为 JSON 关卡。
2. 增加倒计时和多关卡状态。
3. 收集时生成 3D 粒子和音效。
4. 使用 glTF 替换小球，并通过 Animation3D 播放角色动画。
5. 使用 `Physics3DSystem` 实现真正的滚动物理。
6. 增加暂停菜单、触屏虚拟摇杆和游戏手柄适配。
7. 给水晶加入 emissive bloom 后期处理。

仓库内的相关可运行示例：

- [`examples/pbr-showcase`](../../examples/pbr-showcase/)：PBR、环境光、阴影和材质能力；
- [`examples/orbit-control`](../../examples/orbit-control/)：相机旋转、平移、缩放和触摸输入；
- [`examples/physics3d-collision`](../../examples/physics3d-collision/)：3D 刚体和碰撞；
- [`games/sokoban-3d`](../../games/sokoban-3d/)：更完整的 3D 关卡游戏。
