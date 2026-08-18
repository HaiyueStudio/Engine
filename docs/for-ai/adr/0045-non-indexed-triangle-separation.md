# ADR 0045：逐三角形顶点分离采用非索引 Geometry3D 转换

- 状态：Accepted
- 日期：2026-07-26
- 影响：`@haiyue/engine/geometry`、Geometry3D 顶点属性与稳定 API 门禁

## 背景

逐面延迟、爆炸、折叠、置换等 BAS 风格效果需要给一个三角形的三个顶点写入相同的自定义参数。索引网格会让相邻三角形复用顶点，无法在不影响相邻面的前提下表达这些逐面数据。调用方可以手写去索引逻辑，但容易只复制 position 而遗漏 UV、morph 或 skinning 数据。

## 决策

1. 新增纯函数 `separateGeometryTriangles(source)`，仅从 `@haiyue/engine/geometry` 导出，不进入根黄金路径。
2. 输入只接受默认或显式 `triangle-list`；索引数或非索引顶点数必须能组成完整三角形。
3. 输出是新的非索引 `Geometry3D`，`indices === null`，每三个连续顶点只属于一个三角形。
4. 保留三角形顺序、绕序和退化三角形，不隐式重算法线或焊接顶点。
5. position、normal、全部 TEXCOORD semantic、自定义顶点属性、morph target/base、skinning joints/weights 按索引顺序展开。
6. instance attribute、joint matrix、morph weight、渲染状态和 bounds 契约复制但不按顶点展开。
7. 不修改输入；输出数组不与输入数组共享。运行边界发现拓扑、索引或属性长度无效时抛出 `E_GEOMETRY_INVALID_PARAMETER`。

## 结果

- 调用方可在转换结果上安全添加逐三角形 custom attribute，作为后续 GPU 顶点动画的基础。
- 顶点数量会增长到 `triangleCount * 3`，这是显式选择该转换的内存代价；通用加载器不会自动执行。
- 本轮不引入逐面 metadata、动画 shader、缓存、Worker 或原地转换 API。
- `./geometry` 稳定 surface budget 从 48 增至 49；默认入口仍保持 30 个黄金路径概念。
