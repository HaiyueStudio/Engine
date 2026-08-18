# Material Surface 与组合顺序

> 实现状态：Surface v1 定义 14 个稳定槽位。通用 Material Graph 的 metallic-roughness lowering v1 当前只消费基础 7 槽位；高级 7 槽位会以 `E_SHADER_SURFACE_UNSUPPORTED` 精确失败，不再被静默忽略。阶段 10–12 的 production shader family 与这个通用 Graph lowering 是两条独立交付路径。

## 设计原则

材质 graph 修改稳定语义槽位，而不是把字符串插入某段 WGSL。PBR、Toon、Unlit 是 lighting model；normal map、渐变、噪声、dissolve 是可组合表达式或 surface modifier；Fog、shadow 和 IBL 是 scene feature。

## Surface v1

下列槽位构成 `MaterialSurface` v1：

| 槽位 | 类型/空间 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseColor` | linear color3 | `(1,1,1)` | 灯光前反照率 |
| `opacity` | `f32` | `1` | 覆盖率/混合输入 |
| `normalTS` | tangent normal3 | `(0,0,1)` | 显式切线空间法线 |
| `metallic` | `f32` | `0` | PBR metallic |
| `roughness` | `f32` | `1` | PBR perceptual roughness |
| `occlusion` | `f32` | `1` | ambient occlusion multiplier |
| `emissive` | linear color3 | `(0,0,0)` | 自发光 |
| `transmission` | `f32` | `0` | 透射比例 |
| `thickness` | `f32` | `0` | volume thickness |
| `clearcoat` | `f32` | `0` | clearcoat lobe |
| `clearcoatRoughness` | `f32` | `0` | clearcoat roughness |
| `clearcoatNormalTS` | tangent normal3 | `(0,0,1)` | clearcoat normal |
| `sheenColor` | linear color3 | `(0,0,0)` | sheen color |
| `sheenRoughness` | `f32` | `0` | sheen roughness |

所有标量在 validator 之后必须位于模型允许范围；clamp 是标准库节点或 lighting model 的明确策略，不能由不同 backend 随意决定。

### metallic-roughness Graph lowering v1 支持矩阵

- 已消费：`baseColor`、`opacity`、`normalTS`、`metallic`、`roughness`、`occlusion`、`emissive`。
- 暂未消费：`transmission`、`thickness`、`clearcoat`、`clearcoatRoughness`、`clearcoatNormalTS`、`sheenColor`、`sheenRoughness`。
- Graph 显式写入暂未消费的槽位时，编译器必须在 `outputs.<slot>` 抛出 `E_SHADER_SURFACE_UNSUPPORTED`，并给出所需 capability；禁止把值编译后交给 DCE 静默丢弃。

权威机器契约由 `METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT` 与 [stage3-contract.json](./stage3-contract.json) 共同记录。新增 lighting model 或高级 PBR lowering 时，必须先更新此矩阵和对应像素门禁。

## 当前可执行的 Graph v1 Root

Graph v1 JSON root 只有以下字段：

- 必填：`format`、`version`、`kind`、`profile`、`resources`、`nodes`、`outputs`；
- 可选：`sceneFeatures`、`metadata`。

对于 `compileMaterialGraphV1()`，`outputs` 直接绑定上面的 `MaterialSurface` 槽位，lighting model 固定为 `metallic-roughness`，`sceneFeatures` 当前只接受 `scene.fog`。Graph v1 没有 `surface` 包裹字段，也不能在 root 选择 lighting model。

以下是目标材质架构中的概念，但不是 Graph v1 可写的 root 字段：

| 概念字段 | 当前 owner | Graph v1 行为 |
| --- | --- | --- |
| `surface` | `outputs` | 使用 `outputs.<slot>`；root 写入该字段会精确失败 |
| `lightingModel` | compiler entrypoint | `compileMaterialGraphV1()` 固定选择 metallic-roughness |
| `coverage` | renderer material descriptor | alpha mode、cutoff、sidedness 和 pass coverage 仍由 renderer 材质状态拥有 |
| `vertexDisplacement` | deformation program v1 | 使用独立的 deformation pass-family contract |
| `passRequirements` | compiler reflection / RenderGraph | 是 compiler 输出，不允许由 Graph v1 root 自行声明 |

parser 对这些字段返回 `E_SHADER_GRAPH_INVALID`、准确 JSON path、当前 owner 和迁移指引。节点仍不能直接创建 render pass；需要 scene color 的未来 transmission/refraction lowering 应产生 compiler-owned requirement，由 RenderGraph/renderer 决定纹理、顺序和降级。

## 目标材质编译流水线

以下是整体 compiler/renderer 的确定性组合顺序，不代表每一步都能由 Graph v1 root 配置。当前 Material Graph pilot 只覆盖 surface 表达式、metallic-roughness lighting 和 lighting 后 Fog；deformation/pass 派生由阶段 4/10 的独立 contract 提供。

1. 读取 geometry semantics。
2. 执行 morph、skinning 与 custom displacement。
3. 建立 material UV、TBN、world/view direction。
4. 计算 surface 槽位。
5. 执行 alpha coverage/discard。
6. 执行 lighting model。
7. 应用 shadow、IBL 和其他 scene lighting contributions。
8. 应用 scene Fog。
9. 写入 linear scene color；tone mapping/encoding 属于后处理或 target output contract。

节点只能通过命名 hook 参与上述阶段。hook 声明 `requires`、`provides`、`conflicts`、stage、space 和 pass requirement；同一 exclusive hook 有多个 provider 时编译失败。

## 多 Pass 一致性目标

一个 material/geometry graph 必须派生需要的 pass program：

| 子图 | Forward/PBR | Depth | Shadow | Motion vector | Outline/selection |
| --- | --- | --- | --- | --- | --- |
| morph/skinning/displacement | 是 | 是 | 是 | current + previous | 是 |
| alpha coverage | 是 | 是 | 是 | 是 | 是 |
| surface textures/BRDF | 是 | 否 | 否 | 否 | 否 |
| Fog/IBL/shadow receive | 是 | 否 | 否 | 否 | 否 |

pass specialization 通过 DCE 删除无关 surface/lighting 逻辑，但不得复制第二份 deformation 实现。当前该约束由 deformation pass family 实现，不是 Graph v1 root 的承诺。

## 后续 lowering 的兼容性门禁

- 没有 NORMAL/TANGENT 时，normal-map node 必须选择导数 TBN capability 或精确失败。
- 缺失 UV semantic 时不允许静默使用零 UV。
- transmission/refraction 缺少 scene-color pass 时必须产生 capability diagnostic。
- transparent material 的 depth/shadow coverage 必须显式定义，不能沿用 opaque 假设。
- custom lighting model 必须说明是否支持 shadow、IBL、Fog、depth、motion-vector 和 WebGL2 profile。
- Scene Fog 默认位于 lighting 之后；材质需要局部雾化效果时应使用不同命名的 surface effect，不能覆盖 scene Fog。
