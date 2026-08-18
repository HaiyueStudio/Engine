# `@haiyue/engine/navigation`

## 构建与查询

- `NavMesh`：持有不可变地形栅格、静态净空和可更新动态障碍。
- `NavMesh.fromGeometry(geometry, options)`：从 `Geometry3D` 的 position/index 数据栅格化最高表面并过滤陡坡。
- `NavMesh.findPath(start, target, agentOptions, out?)`：按代理体积执行 A*、路径平滑和最近可达点回退。
- `NavMesh.projectPoint(position, agentOptions, out?)`：投影到距离最近的代理可用单元。
- `NavMesh.isPositionWalkable(position, agentOptions)`：检查位置、净空和动态障碍。
- `NavMesh.setObstacle()`、`removeObstacle()`、`clearObstacles()`：维护动态圆形障碍。

## 数据类型

- `NavMeshBuildOptions`：`cellSize`、`maxSlopeRadians`、`maxStepHeight`、`boundsPadding`。
- `NavMeshAgentOptions`：`radius`、可选 `maxStepHeight` 和 `ignoreObstacleIds`。
- `NavMeshObstacle`：稳定 `id`、三维 `position`、`radius` 和可选 `enabled`。
- `NavMeshPath`：可复用路径结果，包含 `points`、`pointCount`、`status`、`visitedNodeCount`、`requestedTarget` 和 `resolvedTarget`。
- `NavMeshPathStatus`：`complete | partial | invalid-start`。

参数、网格数组或几何数据不合法时抛出 `E_GEOMETRY_INVALID_PARAMETER`。精确声明以 `engine/dist/navigation.d.ts` 为准。
