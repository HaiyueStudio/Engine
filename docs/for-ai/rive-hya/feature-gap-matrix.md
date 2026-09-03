# Rive 7.3 → current HYA feature/gap matrix

本矩阵基于 `rive-7.3-webgl2-2.40.0`，不是对未来 Rive 的预测。逐 key 事实源是 [`runtime-census.json`](./runtime-census.json)；这里汇总语义差距与 Goal owner。

## 机械统计

| Family | Runtime objects | Properties | 当前 HYA | Owner |
| --- | ---: | ---: | --- | --- |
| import-neutral-ir | 8 partial | 8 full + 33 partial | 基础 canvas/node/transform 可表达；无 `.riv` reader、multi-artboard/import IR | G02 |
| vector-paint-composite | 29 partial | 19 full + 58 partial | path、solid/gradient、stroke、morph、trim/round、screen blend 与 layout clip 有基础；effects/feather/multi-paint/其余 blend/composite 不完整 | G03 |
| rig-mesh-constraint | 22 partial | 8 full + 84 partial | sampled deformable pose 可播放；参数化 bones/weights/joystick/constraints 不完整 | G04 |
| text-layout-component-asset | 20 partial + 17 missing | 14 full + 57 partial + 115 missing | 基础 text/image/font resource 有；Rive shaping、layout、nested components、asset replacement 不完整 | G05 |
| timeline-state-machine | 59 partial | 77 partial | typed inputs/layers/basic blend 有；完整 property animation/listener/transition semantics 不完整 | G06 |
| data-interaction-accessibility | 115 missing | 132 missing | 无 View Model/list/converter/listener/input/focus/semantic tree 通用 ABI | G07 |
| audio-event | 2 partial | 2 partial | 基础 audio component 有；sample-accurate event/clock/voice/owner 不完整 | G08 |
| scripting-custom-rendering | 16 missing | 11 missing | trusted-project JS 与 shader-language 不能承载不可信 Rive scripts；无 sandbox protocol | G09 |

此外 census 记录 48 个 Luau registration module、349 个注册 symbol 和 14 个 `generated/assets/` type definition（其中 9 个进入 `CoreRegistry` 可序列化 object）；它们都拥有 diagnostic 与 fixture owner，未分类计数为 0。View Model/bindable asset references 仍在完整 object/property census 中，但不重复计入 file asset type 汇总。

按 ADR 0089，source classification 与正式素材 coverage 分开：618 个 property 中 565 个具有 generated `deserialize` case，14 个 asset definition 中 9 个可实例化；只有这些 binary-eligible key 进入 `.riv` encounter denominator。48/349 script registration 项通过本表的 scripting capability mapping、正式 workload 与 security/differential trace闭合，不作为 wire key 计数。

`full` 只表示当前 HYA 能完整表达一个孤立 property 的值域/插值，例如常见 transform、opacity、部分 paint scalar；它不把所属 Rive object 自动升级为完整支持。object 仍为 `partial`，直到其全部 properties、依赖关系和 runtime observable 通过 oracle。

## 必须补全的能力

### File、Artboard 与 Component

- `RIVE` header、ToC field typing、7.3 exact gate、unknown object/property early rejection；tuple 逐 key接受的 runtime-null object 必须完整消费、预算并独立报告，不能 materialize。
- 多 Artboard、default artboard/state machine、Component/nested instance、simple/remap/mix、动态 Artboard property。
- fit/alignment/intrinsic size、instance recursion、late asset/reference resolution 与唯一 owner。
- 完整 `NeutralAnimationIR@1` inventory；source type/property key 只在 provenance side table。

### Vector、paint、image 与 compositing

- procedural paths 的所有可动画参数、多 fill/stroke、有序 effect group、fill rule、blend、clip 与 draw rule。
- gradient stop/transform/opacity、dash/trim、feather、image mesh、N-slice、solo/draw-order。
- `official-inventory-demo-v2` 已在 production lowering 中保留 gradient opacity，并把带 inner Feather 的 gradient 限制到边缘带；但 HYA vector paint 还没有每个 fill 的 signed-distance feather，backpack shell 仍只能使用 gradient stroke 近似。因此该素材的 paint blocker 和本族 `partial` 状态均未关闭。
- custom path effect 只能通过 G09 sandboxed protocol；不得直接注入 renderer。
- `visual-baked` 仅可用于无任何 runtime observable 的纯视觉局部，并保留误差/采样 attribution。

### Rig、mesh、joystick 与 constraints

- bones/root bone/skin/weight/tendon、mesh vertices 与 parameterized deformation，而非只保存 sampled final vertices。
- IK、distance、translation、rotation、scale、transform、follow-path、scroll constraints 的 source order、strength、limits、target space、cycle handling。
- joystick、nested control、draw order、mask、paint/visibility channels；pose mixing 和 state-machine ownership 不覆盖彼此。

### Text、layout、components 与 assets

- HarfBuzz-compatible shaping、SheenBidi-equivalent bidi、runs/styles、font feature/variation axes、modifier ranges/falloff、text on path/input selection。
- Yoga-equivalent row/column/grid、absolute/relative、hug/fill、min/max、gap/padding/alignment、overflow、reflow animation。
- scroll physics/snap/bar/virtualization/carousel、responsive resize、N-slice 和 nested component sizing。
- embedded/referenced/hosted font/image/blob/text/manifest assets；hash、MIME、CORS/URL policy、replacement identity 与 disposal。

当前定向 differential 中，`official-text-fit` 的 shaping、word wrap、`scale`/`font-size` fit、overflow 与自定义行高已在诊断环境达到 pixel validator `passed`（最大通道差 `1/255`、changed pixel ratio `0`、SSIM `0.9999994597`）。`official-text-style-background` 的多 style run、字体 outline、joined background bounds 与 painter order 已对齐，但每帧仍有 `3–6` 个字形边缘采样像素不同（最大通道差 `104/255`、最高 changed pixel ratio `0.00146484375`），所以 text family 继续保持 `partial`；该结果也不能替代 clean revision 的正式设备 trace。

### Timeline、state machine 与 mixing

- every keyable property、step/linear/cubic/value interpolators、one-shot/loop/ping-pong、speed/reverse、nested remap/mix。
- entry/exit/any、single/1D/direct/additive blend、layer order、exit time/pause、ordered conditions/comparators、focus/listener actions。
- fixed timestamp ordering、seek/settle determinism、event emission exactly-once 和 per-channel ownership/mixing。

当前的官方 Eight Planets 有界回归已支持 pointer boolean listener、启用 work area 的时间轴裁剪、入场后循环 idle、独立 exit tail、拓扑稳定 vertex/path morph、Rive Hold/STEP 关键帧、LayoutComponent 圆角裁剪、Drawable screen blend，以及由已解析 nested-fit 倍率降级出的 hover scale。pointer exit 会先执行 `NeptuneOut → NeptuneDefault`，完成缩小和位置复位后才切回 idle tree；重新 enter 会重播入场。上述能力只覆盖该素材命中的确定性子图；通用 flex reflow、拓扑变化 path、其余 blend mode、任意 condition/blend/interruption 与其他 listener 类型仍属缺口，因此本族不升级为 `full`。

播放器现可声明 `loopStartTime` 与 `loopEndTime`：首轮从 0 播放，只循环中间的 idle 区间，并保留 loop end 后的 exit tail 供交互离开时单次执行。Eight Planets 同时消费父 boolean transition 的 `200 ms` duration，并以 resolved nested-fit scale、垂直中心补偿和扣除运行时缩放自带位移后的剩余水平锚点补偿还原放大/缩小。省略 `interpolationType` 的 Rive keyframe 按 schema 默认 Hold 生成 HYA STEP track，轮廓因此保留逐段跳转节奏；普通 vertex/path morph 仍连续插值。`LayoutComponent.clip=true` 会生成继承到子树的圆角 alpha mask，Vapor 的 Rive screen blend 则由 WebGPU 固定混合执行。这不等同于实现通用 transition blending、所有 blend mode 或 Yoga reflow。

### Data、interaction、events 与 accessibility

- View Model number/bool/trigger/string/enum/color、nested VM、list、asset/artboard、default instance/global context。
- converters/formula/group/range/string/list operations、transaction/observation ordering、property groups 与 resource replacement。
- pointer enter/exit/down/up/click/drag、keyboard/gamepad/text/semantic input、focus traversal、hit-test、nested routing。
- role/name/description/value/state/actions/navigation order/live updates/reduced-motion；DOM overlay 只是 bridge，不是 semantic source。

### Audio

- embedded/referenced audio、timeline/event scheduling、sample offset/rate/gain/loop、multi-voice policy、autoplay resume、seek。
- audio clock 与 visual/event clock 映射；abort/project close/reimport/device change 后无继续播放或 owner residual。

### Luau 与 custom WGSL

- 349 个 frozen registration symbol 都必须明确映射为 typed host API、受限替代或 stable failure；不得暴露 DOM、network、filesystem、ambient clock/random、main-thread JS 或 unrestricted GPU。
- Luau instruction/heap/call/output/event budgets、cooperative cancellation、deterministic seed/clock、capability manifest。
- WGSL 独立解析/验证、entry/binding allow-list、resource ceilings、pipeline timeout、device-loss owner；不得拼接 HaiYue production shader ABI。

## Profile 判定

| Observable | visual-baked | native-semantic | full-fidelity 要求 |
| --- | --- | --- | --- |
| deterministic visual geometry/paint | 允许，有误差/极值证据 | 允许 | 二者之一通过 oracle |
| timeline/state machine | 只有不对外可观察的纯视觉内部子图 | 必需 | state/seek/mix trace 相等 |
| layout resize/scroll | 禁止 | 必需 | 每个 viewport/DPR tree/geometry 相等 |
| data binding/resource replacement | 禁止 | 必需 | transaction/value/identity trace 相等 |
| pointer/keyboard/gamepad/focus/events | 禁止 | 必需 | order/target/payload 相等 |
| audio | 禁止 | 必需 | schedule/clock/voice trace 相等 |
| semantics/reduced motion | 禁止 | 必需 | semantic tree/action trace 相等 |
| Luau/WGSL | 禁止录制结果代替 | sandbox protocol 必需 | capability/output/resource trace 相等 |

任何一行出现 unknown、unmapped、silent approximation 或只有 screenshot 证据，整份资产不能标为 `full-fidelity`。
