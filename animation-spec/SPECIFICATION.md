# Haiyue Animation 1.0

## 1. 目标

Haiyue Animation 是动效的运行时中间表示（IR）。规范优先保证：浏览器低分配解析、可预测的能力集合、未知可选能力可跳过、必需能力明确失败，以及来源格式不进入播放器依赖图。

`format` 固定为 `haiyue-animation`，规范版本固定为 `1.0`。容器扩展名为 `.hya`，MIME 为 `application/vnd.haiyue.animation`。

## 2. 时间与坐标

- 所有持久化时间单位都是秒；`frameRate` 仅保留创作信息，不参与运行时寻址。
- `duration` 必须大于零，track 时间严格递增并位于 `[0, duration]`。
- v1 坐标系固定为 `screen-y-down`：原点位于画布左上，x 向右，y 向下；旋转使用弧度。
- transform 的 `position`、`rotation`、`scale`、`anchor`、`opacity` 默认分别为 `[0,0]`、`0`、`[1,1]`、`[0,0]`、`1`。

## 3. 文档模型

文档由定宽画布、资源表、扁平节点表和 SoA 友好的 track 表组成。节点通过稳定字符串 id 与 parent id 建树；格式禁止重复 id、悬空 parent 和循环。组件是节点的视觉或行为能力。

v1 核心组件包括：

- `shape2d`：`rect` 或 `ellipse`、局部位置、尺寸和线性 RGBA fill；
- `sprite2d`：image 资源 id、局部位置、尺寸、可选 tint 和归一化 `uvRect`；可用 `uvRectTrack` 的 STEP 关键帧在同一 atlas 内切换来源区域，`valueSize` 固定为 4，每个矩形都必须完整位于 `[0,1]`；
- `path2d`：紧凑的 `M/L/Q/C/Z` command stream、连续 float values、fill、fill rule 和细分容差。
- `text2d`：UTF-16 text、布局尺寸、字体样式、对齐、颜色与栅格化倍率；可包含 step-keyed text document、binary font resource、tracking，以及最多 16 个按顺序执行的字符 animator/range selector；
- `particle2d`：固定最大容量、发射率/首帧 burst、确定性 seed、生命周期/速度/尺寸范围、重力、形状、颜色和混合模式；可引用一个 image；
- `audio`：引用 audio resource，并声明 volume、loop、start offset 与 playback rate。

image 资源默认按 sRGB 采样，可用 `colorSpace: "linear"` 显式覆盖。sprite 与 particle texture 必须引用 image，audio component 必须引用 audio resource，均不能引用任意 binary 资源。

text document 可以切换 text、font family/size/weight/style、font resource、line height、tracking、alignment 和 color。runtime 使用确定性的 grapheme 边界与 Canvas shaping；映射到 web font 的资源必须是 binary，加载完成后重建文字 atlas。字符 animator 支持 position、scale、rotation、opacity、fill color 与 tracking；selector 支持 percent/index、square/ramp/triangle/round/smooth、动画 start/end/offset/amount、characters/characters-excluding-spaces/words/lines 分组、shape easing、smoothness，以及基于 uint32 seed 的确定性随机排列。Lottie `rn` 不得在播放时调用 `Math.random()`；转换器从稳定 source path 派生 seed。expression selector 与 text document expression 不在 Web runtime 执行，必须保留静态 fallback、精确 diagnostic 和离线 bake 路径。

节点的 `effects` 是最多 8 项的有序、来源无关效果栈。v1 支持 tint、fill、opacity、4×5 color matrix、二维 blur 和 drop shadow；静态值与普通 step/linear/cubic-bezier value track 使用相同 Float32 pool。运行时按数组顺序执行，颜色效果、模糊和投影不得在导入阶段静默烘焙进某个特定组件。未覆盖的 AE effect、plugin 或 expression 保持离线 bake/no-go，并指向原始 effect/parameter path。

Lottie type 15 data layer 是非视觉数据依赖：引用的 payload 以 `binary` resource 保存，节点通过 `org.haiyue.data-layer@1` 记录 resource 与 media type。该扩展只保留来源和依赖关系，不解释或执行引用它的 JavaScript expression；因此数据层可完整转换，而表达式能力必须单独归因。

节点可用 `composite` 引用另一个稳定 node id 作为 `mask` 或 `matte`。单层对象保持早期格式兼容；`{ layers: [...] }` 表示最多 8 层的有序复合栈。每层模式可为 `alpha`、`alpha-inverted`、`luma`、`luma-inverted`，操作可为 `add`、`subtract`、`intersect`、`difference`，并可携带非负 feather、有符号 expansion 和可选 scalar `expansionTrack`。source 节点及其子树只参与离屏来源输出，不再进入主颜色输出；source 自身可以引用更早的 composite source，从而表达嵌套 matte，以及在不扩宽单 Pass texture ABI 的情况下分解大型有序 mask 栈。自引用、环和悬空引用在 JSON 与 compact binary 两条路径上都必须失败。

`org.haiyue.vector-shape@1` 是内建、来源无关的 vector visual component。它包含一条稳定 `M/L/Q/C/Z` topology、初始 values、可选 morph track，以及 fill 或 stroke paint。`morphRelative: true` 表示 morph 每个 sample 是相对初始 values 的逐分量 delta；缺省或 false 继续表示绝对坐标。fill 支持 solid、linear-gradient 与 radial-gradient；stroke 支持 width/cap/join/miter、dash、gradient。颜色、paint opacity、gradient geometry/stops、width 和 dash offset 可以携带普通 step/linear/cubic-bezier value track。`modifiers` 是最多 8 项的有序数组，当前包含 animated `trim-path`（simultaneous/individual）与 `round-corners`；运行时严格按数组顺序在 geometry tessellation 前执行。Lottie converter 对 animated path 坐标使用 1/64 canvas-unit 网格，最大转换误差为 1/128 unit，同时避免不可压缩的任意 Float32 mantissa。gradient stops 限制为 2–8 个有序 `offset,r,g,b,a` 元组，paint opacity 与颜色 alpha 分开存储。所有内嵌 track 时间必须落在 composition duration 内。

v1 track 属性是 `position`、`rotation`、`scale`、`opacity`。`times` 与 `values` 紧密排列；position/scale 每帧两个 float，其余属性每帧一个 float。cubic-bezier 每个相邻关键帧段保存一个 temporal `x1,y1,x2,y2`，两个 x 必须位于 `[0,1]`。position 可额外保存每段 4 个 `spatialTangents`，依次为相对起点的 outgoing xy 和相对终点的 incoming xy；temporal easing 决定曲线进度，spatial cubic 决定二维轨迹，二者不得混用。

JSON Schema 描述 authoring JSON 的结构；parser 还会检查跨表引用、层级、数值有限性、计数和输入字节预算。实现必须在创建字符串纹理或粒子 SoA 前检查 `maxTextCharacters` 与 `maxParticleCapacity` 的全 composition 预算。

## 4. 二进制容器 HYA1

所有整数和 float 都是 little-endian。24 字节 header 依次为：

| Offset | 类型 | 内容 |
| ---: | --- | --- |
| 0 | `u32` | magic `HYA1` |
| 4 | `u16` | container major = 1 |
| 6 | `u16` | container minor = 0 |
| 8 | `u32` | metadata byte offset |
| 12 | `u32` | metadata byte length |
| 16 | `u32` | 4-byte aligned float pool offset |
| 20 | `u32` | float count |

metadata 是 UTF-8 JSON，但 track 数组、`path2d.values`、文字 animator track 和 effect track 以 `{offset,length}` 引用一个连续 `Float32` pool。解码器在原始 `ArrayBuffer` 上创建 view，不逐 track/path 分配或复制。text document、particle 配置和 audio/font 引用保留在 metadata；资源 payload 不嵌入 HYA1，通过 URI、MIME 和可选 integrity 独立缓存。新增 compact node/effect/text 字段是可选尾部字段，旧 v1/v2 binary 继续可读。

## 5. 扩展

扩展 id 必须是带 major 的命名空间，例如 `org.example.particle@1`。文档在 `extensionsUsed` 声明全部扩展；不能降级的扩展同时放入 `extensionsRequired`。

- 未注册的 optional 扩展组件可被 runtime 跳过。
- 未注册的 required 扩展必须在创建运行时对象前失败。
- 扩展 major 不兼容时使用新 id，不在同一 id 下改变语义。
- 注册表按 handler 身份 token 化注销，旧插件不能移除后注册的实现。

新增通用能力应先以扩展验证数据模型和性能；只有多个独立生产用例都需要且有跨 runtime 一致语义时，才进入下一个 core version。

具体播放器可以提供同 id 的 runtime handler。Haiyue 2D handler 获得 anchor-adjusted parent，并返回支持确定性 `apply(compositionTime, opacity)` 与 `destroy()` 的实例；实现必须能处理 seek、循环回绕和重复释放，不能假设时间只单调前进。

### 5.1 内建动画状态机扩展

`org.haiyue.animation-state-machine@1` 是内建的 versioned document extension，因此作为 required extension 时不要求外部格式 registry。基础 `parseAnimation()` 负责不可信输入的容器、metadata 和总量预算；`parseHyaStateMachineExtension()` 负责下列严格语义校验，状态机 runtime 会在创建任何 Entity、视觉或 GPU 资源前调用它。payload 包含：

- `clips`：唯一 id、可选 name、composition 内的 `start`/`duration`；所有区间必须完整落在文档 duration 内；
- `stateMachine`：固定 format `haiyue-animation-state-machine@1`，以及 parameters、layers、states、transitions；
- state motion 可以直接引用 clip，或用 float/integer 参数构成递归但有深度预算的 1D/2D Blend Tree；
- transition condition 必须与参数类型匹配；声明顺序决定同一帧内的优先级；trigger 只由成功选中的 transition 消费；
- layer 可以声明 override/additive、weight 以及稳定 binding id 的 include/exclude mask。

状态机描述不烘焙进每条 track。JSON 和 HYA binary 都通过现有 document extension metadata 保存该 payload，keyframe float pool 和旧 container 解码路径不变。播放实现必须让多个 clip 共享一份解析结果、资源句柄和节点实例；cross-fade 只混合 pose，不能通过并行创建两个完整素材实例来伪装状态切换。

Haiyue 2D runtime 将 position、rotation、scale、opacity 和 node visibility 作为 pose binding。step、linear 与裁剪后的 cubic-bezier 必须保持原采样语义。audio、particle、animated path morph 或未知时间副作用尚未具有混合协议时，adapter 必须在创建场景节点前失败并指出源组件路径，不能静默丢弃或退回两份素材播放。

### 5.2 原生 3D 必需扩展

原生 3D 不改变 HYA core 1.0 的 2D transform 语义。它使用 required document extension `org.haiyue.animation-3d@1`，payload format 为 `haiyue-animation-3d@1`；标识必须同时出现在 `extensionsUsed` 和 `extensionsRequired`。

3D carrier 的 core `canvas` 只表示输出 viewport，core `nodes` 和 `tracks` 必须为空。任何 2D core 内容与 native-3D payload 同时出现都以 `E_ANIMATION_3D_MIXED_DIMENSIONS` 拒绝。3D 坐标固定为右手、`+Y` up、`-Z` forward、米、秒、弧度和 normalized XYZW quaternion；Euler 只属于 authoring UI。

Payload 包含 canonical Transform3D、perspective/orthographic camera、primitive/model、基础 PBR material、Particle3D descriptor、`haiyue-animation3d-clip@1` clip，以及可选 `haiyue-animation3d-state-machine@1` controller。Joint 使用稳定 node id/path 的 transform binding，Morph 使用 `morph.weights`，material/camera 使用有限集合的 property binding。glTF/GLB 仍是来源 adapter 责任，不进入格式 parser。

不支持 3D 的宿主必须在创建 ECS/GPU/runtime owner 前拒绝 required extension。完整字段、预算、diagnostic 和 fixture 由 `schema/animation-3d-extension.schema.json`、`schema/animation-3d.contract.json` 与 `@haiyue/animation-spec/native3d` 构建声明定义；本规范不复制整份 declaration 或 schema。

### 5.3 可变形 2D 网格必需扩展

`org.haiyue.deformable-mesh-2d@1` 用于来源无关的稳定三角拓扑动画。组件引用一个 `binary` data resource 和有序的 `image` resources；二进制 resource 的 media type 为 `application/vnd.haiyue.deformable-mesh-2d`，payload format 为 `haiyue-deformable-mesh-2d@1`（`.hydm`）。格式包含 canvas、时间采样、每个 drawable 的静态 UV/index/mask 引用，以及 frame-major Float32 position/opacity/render-order 数据。HYDM 的图片 UV 原点固定为左上；Cubism capture v1 通过可选 `canvas.uvOrigin` 声明来源，Core capture 写入 `bottom-left` 并在转换阶段只归一化一次，省略字段的旧 capture 按 `top-left` 保持兼容。

宿主必须在创建 GPU owner 前校验 header/version、全部 byte range、预算、有限数、单调时间、顶点与索引范围、稳定 drawable id 和 mask 引用。v1 运行时执行线性顶点/透明度采样、step render order、alpha mask，以及 normal/additive/multiplicative blend；multiply/screen color、culling、参数化输入、Physics 和 motion sync 不得静默宣称精确支持。

Live2D Cubism 是一个构建期 adapter，而不是 runtime 分支。工具可以通过 `model3.json#FileReferences.Motions` 枚举动作分组并让用户选择；许可允许的 Cubism Core 在工具侧把 Motion3 求值成 drawable capture，`@haiyue/animation-spec/live2d` 再转换为本扩展。单 clip 转换仍只写入一个 baked clip；需要运行时无缝切换的工具可以在构建期把同模型、同 topology 的多个动作串接为一个 HYA 时间域，并保存各动作的互不重叠时间区间。切换只改变播放器采样区间，不重建 drawable、纹理或来源 runtime。`.moc3`、Core 和来源 SDK 不进入 HYA 或产品网页 bundle。完整架构边界见 ADR 0083。

组件 schema 与固定预算分别由 `schema/deformable-mesh-2d-extension.schema.json` 和 `schema/deformable-mesh-2d.contract.json` 声明；TypeScript codec 是 sidecar 二进制读写的可执行规范。

## 6. 转换器契约

转换发生在编辑器导入或构建阶段。转换器输出 document、已转换/跳过计数以及带 code、path、severity 的 diagnostics。来源单位、坐标和 easing 必须在转换时归一化；播放器不得保留按来源格式分支。

有损转换在普通模式产生 warning，在 strict 模式失败。未知内容不能被悄悄解释成近似但语义不同的核心组件。

## 7. 安全与版本

输入是不可信数据。实现必须在分配前限制输入、metadata、node、component、track、keyframe、resource、文本字符和粒子总容量，并拒绝 NaN、Infinity、越界引用和非法 binary range。

当前项目没有历史项目兼容负担：不兼容的核心格式变更提升版本并同步迁移仓库数据，不在 parser 内累积永久 fallback。对外发布后的迁移窗口需另立 ADR。
