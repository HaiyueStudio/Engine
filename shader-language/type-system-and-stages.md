# 类型、Stage 与坐标空间

> 实现状态：阶段 2 已实现 scalar/vector/square-matrix expression core、显式 conversion、stage intersection、semantic/space/transform 验证和 WGSL codegen；阶段 3 增加 Graph lowering、TBN/PBR/Fog 所需的 `cross`、`pow`、`sqrt`，并生成 varying reflection。aggregate、控制流、副作用和自动 vertex/varying codegen 仍按 [stage3.md](./stage3.md) 延期。

## 数值类型

IR v1 支持：

- scalar：`bool`、`i32`、`u32`、`f32`；
- vector：`vec2<T>`、`vec3<T>`、`vec4<T>`；
- matrix：`mat2x2<f32>`、`mat3x3<f32>`、`mat4x4<f32>`；
- aggregate：固定长度 array、命名 struct；
- resource handle：sampler、sampled/depth/storage texture、uniform/storage block。

`f16`、subgroup、atomic 和 pointer 不属于 IR v1 portable core，后续只能通过 capability 扩展引入。

类型规则：

1. 不允许 `i32`、`u32`、`f32` 之间隐式转换。
2. scalar 到同类 vector 的 splat 可以由 frontend 省略，但规范化 IR 必须记录显式 splat。
3. vector 维度、matrix 形状、array 长度和 struct identity 必须精确匹配。
4. color 不隐式等于任意 `vec3<f32>`；frontend 可提供显式 `asLinearColor`、`asDirection` 等语义转换。
5. texture sample 的颜色空间转换由资源 metadata 和显式 decode node 决定，不能依赖目标后端猜测。

## Stage

每个表达式记录允许的 stage 集合：`vertex`、`fragment`、`compute`。组合时取交集；空集立即产生 diagnostic。

- attribute、`vertex_index`、`instance_index` 只允许 vertex。
- derivative、implicit-LOD sample、front-facing 只允许 fragment。
- workgroup memory、dispatch id 和 storage write 只允许 compute。
- uniform、常量和纯数学函数可跨 stage。
- 从 vertex 值流向 fragment 时由 allocator 生成 varying；反方向不合法。

整数和布尔 varying 必须使用 flat interpolation。浮点 varying 默认 perspective；normal/direction 等语义可以显式请求 interpolation，但必须经过 target capability 校验。

## 坐标空间

IR v1 的空间标签为：

| 空间 | 典型值 |
| --- | --- |
| `geometry-local` | 原始 position、normal、tangent、morph delta |
| `object` | morph/skinning 后、进入 model matrix 前的位置与方向 |
| `world` | world position、world normal、light direction |
| `view` | view position、view normal、view direction |
| `tangent` | normal map 解码结果、tangent-space direction |
| `clip` | vertex entry point 输出位置 |
| `screen` | UV、pixel coordinate、depth reconstruction |

position、direction、normal 和 UV 除数值类型外必须携带 semantic/space。以下行为非法：

- 把 tangent-space normal 直接赋给 world-space normal；
- 把 position 当 direction 使用平移矩阵；
- 混合不同空间的 position；
- 在没有 inverse/normal matrix 的情况下猜测空间转换；
- 把 screen UV 当 material UV 使用而不显式选择。

空间转换由标准库 node 提供，并记录依赖：

```text
position.geometry-local -> morph -> skin -> position.object
position.object -> model -> position.world
position.world -> view -> position.view
position.world -> viewProjection -> position.clip
normal.tangent -> TBN -> normal.world
```

## 顶点变形顺序

默认顺序固定为：

1. geometry attributes；
2. morph position/normal；
3. skinning；
4. material custom displacement（object space）；
5. object-to-world；
6. world-to-view/clip。

需要 pre-skin deformation 的高级模块必须声明专用 hook 和 joint-space 语义，不能通过排序数字插到任意位置。

motion-vector pass 同时执行 current/previous 两套相同结构的变形图；时间、morph weight、joint matrix、model matrix 等历史输入通过语义资源区分。history 不可用时 previous 必须回退 current。

## 控制流与副作用

IR 必须能表达 `if`、`switch`、bounded loop、return、discard 和 storage write，但 portable material core 只允许纯表达式、条件和 fragment discard。

- graph v1 不允许任意递归。
- loop 必须有静态可证明的上界或 target capability。
- derivative 受 uniformity 规则约束。
- discard 只允许 fragment coverage 阶段。
- storage write 只能出现在显式 compute graph，不能藏在材质 node 中。

## Diagnostic

每个 IR node 保留 frontend source：文件/行列或 graph node/port。错误至少包含：

- 稳定 diagnostic code；
- node/module id；
- 期望与实际类型；
- stage/space/capability；
- 依赖路径；
- 生成源码位置（如果已经 codegen）。

目标编译器的错误必须映射回原 node/module，不能只返回合并后 WGSL 行号。
