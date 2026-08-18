# NavMesh 与 RTS 寻路

`@haiyue/engine/navigation` 提供面向 Y-up 地形的栅格化 NavMesh。构建阶段从三角网格采样最高表面，并过滤超过最大坡度的区域；查询阶段再叠加代理半径、最大台阶高度和动态圆形障碍，因此大小不同的代理可以共享同一份 NavMesh。

```ts
import { NavMesh, NavMeshPath } from '@haiyue/engine/navigation';

const navMesh = NavMesh.fromGeometry(terrainGeometry, {
  cellSize: 0.4,
  maxSlopeRadians: Math.PI / 4,
  maxStepHeight: 0.35,
});

navMesh.setObstacle({
  id: 'unit-42',
  position: [2, 0, 3],
  radius: 0.5,
});

const reusablePath = new NavMeshPath();
navMesh.findPath(
  [0, 0, 0],
  [8, 0, 4],
  { radius: 0.35, ignoreObstacleIds: ['unit-42'] },
  reusablePath,
);
```

## 表面洞与逐帧地面判断

几何体在某个 X/Z 区域没有三角形，或显式 grid 的 `heights` 为 `NaN` / `walkable` 为 0 时，该区域就是不可行走的表面洞。A* 和路径平滑都会绕开它。

逐帧角色移动不要用 `projectPoint()` 判断脚下是否有地面：它会有意寻找附近的最近可达格子。使用 `sampleSurface()`；该方法只检查输入 X/Z 所在格，不跨洞吸附，返回 `null` 就表示本地没有可用支撑。

```ts
const sample = new Float32Array(3);
const hit = navMesh.sampleSurface(playerPosition, { radius: 0 }, sample);

if (hit) {
  playerPosition[1] = hit[1] + playerRadius;
} else {
  // 洞、边界或被查询期条件阻挡：继续重力积分。
}
```

`sampleSurface()` 保留输入 X/Z，只写入采样到的 Y，适合连续角色运动。代理半径大于 0 时，洞边缘的静态净空也会生效；球体落洞演示使用 `radius: 0` 判断球心下方是否仍有支撑。

## 路径结果

- `complete`：请求目标位于可行走区域，并和起点连通。
- `partial`：目标不可行走或不连通，路径终点是起点连通区域中最接近请求目标的位置。
- `invalid-start`：当前代理找不到任何可用起点。

`NavMeshPath` 使用可增长的 `Float32Array` 保存路点。高频重寻路应复用结果对象，通过 `pointCount` 读取有效范围。

## 不同体积的代理

静态净空在构建阶段计算，但代理半径在查询时提供。窄通道不需要为每种角色重复构建 NavMesh：小半径代理可以通过，大半径代理会选择更宽的替代路线；没有替代路线时返回 partial。

## 动态障碍和碰撞

球形单位可通过 `setObstacle()` 按稳定 id 更新位置和半径。为代理自身寻路时，将自身 id 放入 `ignoreObstacleIds`。NavMesh 负责路径级避障；逐帧移动仍应执行精确的球体碰撞测试，并在通道被移动单位封锁时重新查询路径。

## 构建限制

当前实现针对地形和 RTS 场景：Y 轴向上、每个 X/Z 栅格只保留最高表面。传入的顶点应已经处于同一世界坐标系。洞穴、多层桥梁和任意重力方向需要后续的分层多边形 NavMesh 后端，不应通过增大当前高度场复杂度解决。

## 编辑器边界

`NavMesh` 是可重建的查询资源，不是场景组件；编辑器不会把 backend、clearance 缓存或动态障碍状态写进场景 JSON。`FirstPersonControls` 同样是依赖具体 Canvas 与目标 transform 的运行时 system。当前编辑器能保存被控制实体和地形资源，但导航构建、`groundProbe` 绑定、控制器安装与 `dispose()` 仍由游戏启动代码或专用 Editor Contribution 负责。这样可避免把 DOM 生命周期和派生缓存固化进可序列化组件。

完整交互示例：

- `examples/navmesh-rts`：大小代理、动态障碍、partial path 与 RTS 点击移动。
- `examples/navmesh-first-person`：真实表面洞、局部支撑判断、Pointer Lock 第一人称球体、重力跳跃和需要跳上的低台阶。
