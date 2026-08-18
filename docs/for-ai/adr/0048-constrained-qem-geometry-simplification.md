# ADR 0048：通用网格简化采用受约束 QEM 边折叠

- 状态：Accepted
- 日期：2026-07-26
- 影响：`@haiyue/engine/geometry`、Geometry3D 顶点属性与稳定 API 门禁

## 背景

引擎已有生成器的低段数选项、LOD 选择和线性 subdivision，但没有把任意现有网格降低三角形数量的公共转换。离线资产处理、运行时生成网格和多级 LOD 构建需要一个来源无关的 simplification 原语。按固定步长删三角形会制造空洞；单纯 vertex clustering 又难以控制曲面误差和拓扑破坏。

经典 QEM 可以用相邻面平面误差为 edge collapse 排序，但无约束求出的最优点可能跑出原边、使手工 bounds 失效，并让 UV、morph、skinning 等属性缺少稳定插值参数。因此这里采用受约束 QEM：误差仍决定折叠次序，候选位置只在边的两个端点与中点中选择。

## 决策

1. 新增纯函数 `simplifyGeometryTriangles(source, options)` 与 `SimplifyGeometryTrianglesOptions`，仅从 `@haiyue/engine/geometry` 导出，不进入根黄金路径。
2. 输入必须是 indexed triangle-list。非索引网格没有可靠的共享边语义，函数不会按浮点 position 擅自焊接；调用方应先提供正确索引拓扑。
3. `targetRatio` 与 `targetTriangleCount` 二选一；默认目标为 50%。目标是 best-effort，拓扑和边界约束可以让结果停在目标之上，重复面清理也可能让最终数略低于目标。
4. 每轮根据当前三角面构建 vertex quadric，以累计平面误差排序 edge collapse。候选位置限制为 first endpoint、midpoint、second endpoint，确保新位置处于原边上。
5. 默认 `preserveBoundary: true`，锁定所有开放边界顶点。显式关闭后允许边界折叠，但仍执行 manifold link condition。
6. 非流形边、link condition 不满足、产生退化邻面或翻转邻面法线的候选必须跳过。
7. 每批只折叠 one-ring 不相交的边；折叠后重新构建 quadrics、邻接和边界，不复用过期误差。
8. position、UV、morph delta 和 numeric custom attribute 按候选边参数插值；normal 与 morph base normal 插值后归一化。
9. skinning 合并两端 joint influence，累加相同 joint，保留权重最高的四项并归一化。instance attribute、joint matrix、morph weight 和渲染状态独立复制。
10. 输入及其 typed array 不被修改或共享。由于新 position 始终位于原边，已有 manual bounds 仍然保守。

## 结果

- 闭合流形网格可按几何误差生成更低三角形版本，并继续进入现有 PBR、morph、skinning 和 LOD 路径。
- UV seam、hard edge 等以 split vertex 表达的边界不会被默认跨越；这是避免错误焊接的保守选择。
- 算法为同步 CPU 转换，适合加载阶段、工具链或中等规模运行时生成网格；大型资产应在 Worker/离线管线执行，本轮不增加隐式异步或 Worker pool。
- 示例在真实 WebGPU 页面中把同一个 1,280-triangle 网格降为 640 和 192 triangles，并用去重线框展示实际拓扑。
- `./geometry` 稳定 surface budget 从 51 增至 53；默认入口仍保持 30 个黄金路径概念。
