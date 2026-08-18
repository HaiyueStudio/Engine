# ADR 0047：通用网格细分采用线性共享边中点转换

- 状态：Accepted
- 日期：2026-07-26
- 影响：`@haiyue/engine/geometry`、Geometry3D 顶点属性与稳定 API 门禁

## 背景

现有 box、rounded box、icosahedron 等生成器可以在创建阶段增加 segments/detail，但引擎没有把一个任意已有 `Geometry3D` 继续细分的公共能力。顶点位移、曲面投影、局部动画和后续 BAS 风格效果需要先增加拓扑密度；如果每个调用方手写中点拆分，容易在共享边产生裂缝，或遗漏 UV、morph、skinning 等渲染数据。

“subdivision”也可能指 Loop、Catmull–Clark 等会移动原顶点的平滑曲面算法。将平滑策略隐式塞进一个通用函数会让轮廓、硬边和资产语义不可预测，因此本轮只建立可组合的线性拓扑细化原语。

## 决策

1. 新增纯函数 `subdivideGeometryTriangles(source, options)` 与 `SubdivideGeometryTrianglesOptions`，仅从 `@haiyue/engine/geometry` 导出，不进入根黄金路径。
2. 每轮在三角形三条边插入中点，并保持绕序拆成四个子三角形；原有顶点位置不移动。
3. 索引输入按顶点索引识别拓扑边，相邻三角形共享同一个中点；非索引输入被视为刻意断开的面，不按浮点位置焊接。
4. 输出始终是新的 indexed triangle-list `Geometry3D`，输入及其 typed array 不被修改或共享。
5. position、UV、morph delta 与 numeric custom attribute 使用线性中点插值；normal 与 morph base normal 插值后归一化。
6. skinning 中点合并两端 joint influence，累加相同 joint，保留权重最高的四项并归一化；joint matrix 不做逐顶点扩张。
7. instance attribute、morph weight、渲染状态与 bounds 契约独立复制。手工 bounds 仍然保守，因为线性中点处在原边内。
8. `iterations` 默认为 1，接受 0–8 的整数；预估结果超过 1,000,000 个三角形时在分配前抛出 `E_GEOMETRY_INVALID_PARAMETER`，避免指数增长造成不可控内存占用。
9. custom attribute 被视为连续 numeric 数据。离散 ID、bit flag 等属性不得依赖默认插值，调用方应在细分后重新生成。

## 结果

- 任意 triangle-list 网格都能先统一增加拓扑密度，再组合顶点位移、曲面投影、morph 或自定义 GPU 效果。
- 函数不承诺 Loop/Catmull–Clark 平滑，不会隐式改变轮廓或跨断边平滑法线。
- 示例用同一个 2-triangle 平面分别细分 0、2、4 轮，再施加相同高度函数，展示 2、32、512 个三角形的差异。
- `./geometry` 稳定 surface budget 从 49 增至 51；默认入口仍保持 30 个黄金路径概念。
