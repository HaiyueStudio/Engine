# ADR 0049：PBR 多方向光阴影使用固定容量 depth texture array

- 状态：Accepted
- 日期：2026-07-26
- 影响：SceneRenderEnvironment、方向光 shadow orchestration、PBR scene ABI、WebGPU 纹理绑定预算

## 背景

ADR 0021 将“大量灯光、shadow atlas 与 CSM”约束为真实游戏基准驱动的规模化工作。当时的稳定实现只为第一盏投影方向光生成一张 shadow map，因此即使小型场景只需要两到三盏方向光，也无法表达多个方向的实时阴影。

直接为每张 shadow map 增加一组 depth texture binding 会让 PBR shader 超过 WebGPU 默认的 fragment sampled-texture 上限：材质、环境、透射和现有阴影已经占满当前绑定预算。引入通用 atlas、Forward+ 或 CSM 又明显超出这个小规模内容需求。

## 决策

1. PBR 固定支持最多 3 盏投影方向光；`SceneRenderEnvironment.shadowLights` 按 World 查询顺序选择前三盏，并把它们以相同顺序放在 `pbrLights` 前部。`shadowLight` 保留为第一项的兼容别名。
2. 三张深度图由一个 `depth32float`、三层的 `texture_2d_array` 持有。PBR 使用一组 texture/sampler binding 和三份 matrix/params uniform，不增加 sampled-texture 数量。
3. 每盏灯仍有独立 shadow pass、caster frustum、camera uniform、caster object table、cache key 和可失效状态。GPU 提交前不得让一盏灯的 queue write 覆盖另一层即将消费的数据；shared geometry/deformation cache 只能在全部待更新层编码结束后按 liveness 并集 sweep。静态场景可逐灯 cache hit；多 camera/view 不重复生成 scene-global shadow map。
4. 同一数组的层尺寸必须一致，运行时采用有效投影方向光中最大的 `mapSize`。这会让较小请求获得更高分辨率，但不会降低任何请求的质量；容量和最大尺寸共同给出确定的显存上限。
5. `DirectionalShadowState.view` 继续提供单层 `texture_2d` view，供现有单阴影 renderer 使用；新增的 array view 和 layer 只由 PBR 多阴影路径消费。
6. 第 4 盏及之后的投影方向光仍进入 8 灯 forward lighting 上限，但不生成阴影。当前不静默宣称它们有 shadow map；示例与文档必须明确这个 capacity。
7. 本决策不引入 shadow atlas、cascades、Forward+、clustered lighting 或公开布尔开关。ADR 0021 的真实游戏基准、设备矩阵和 go/no-go 约束继续适用于这些规模化能力。

## 结果

- 小型 PBR 场景可以用三盏不同方向和颜色的灯产生可辨认的多组阴影，而不突破默认 WebGPU 绑定预算。
- 初始静态帧最多增加到三个 shadow pass，并按最大 map size 分配三层深度显存；这是显式、可观测的成本，不适合作为大量动态灯阴影方案。
- `examples/shadow-map` 同时验证三次初始 shadow pass、静态 cache hit、WebGPU validation error 为零，并直观展示三组阴影。
