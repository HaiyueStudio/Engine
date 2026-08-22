# Rive 7.3 → current HYA feature/gap matrix

本矩阵基于 `rive-7.3-webgl2-2.40.0`，不是对未来 Rive 的预测。逐 key 事实源是 [`runtime-census.json`](./runtime-census.json)；这里汇总语义差距与 Goal owner。

## 机械统计

| Family | Runtime objects | Properties | 当前 HYA | Owner |
| --- | ---: | ---: | --- | --- |
| import-neutral-ir | 8 partial | 8 full + 33 partial | 基础 canvas/node/transform 可表达；无 `.riv` reader、multi-artboard/import IR | G02 |
| vector-paint-composite | 29 partial | 19 full + 58 partial | path、solid/gradient、stroke、morph、trim/round 有基础；effects/feather/multi-paint/composite 不完整 | G03 |
| rig-mesh-constraint | 22 partial | 8 full + 84 partial | sampled deformable pose 可播放；参数化 bones/weights/joystick/constraints 不完整 | G04 |
| text-layout-component-asset | 20 partial + 17 missing | 14 full + 57 partial + 111 missing | 基础 text/image/font resource 有；Rive shaping、layout、nested components、asset replacement 不完整 | G05 |
| timeline-state-machine | 59 partial | 75 partial | typed inputs/layers/basic blend 有；完整 property animation/listener/transition semantics 不完整 | G06 |
| data-interaction-accessibility | 115 missing | 131 missing | 无 View Model/list/converter/listener/input/focus/semantic tree 通用 ABI | G07 |
| audio-event | 2 partial | 2 partial | 基础 audio component 有；sample-accurate event/clock/voice/owner 不完整 | G08 |
| scripting-custom-rendering | 16 missing | 11 missing | trusted-project JS 与 shader-language 不能承载不可信 Rive scripts；无 sandbox protocol | G09 |

此外 census 记录 48 个 Luau registration module、349 个注册 symbol 和 14 个 `generated/assets/` type definition（其中 9 个进入 `CoreRegistry` 可序列化 object）；它们都拥有 diagnostic 与 fixture owner，未分类计数为 0。View Model/bindable asset references 仍在完整 object/property census 中，但不重复计入 file asset type 汇总。

`full` 只表示当前 HYA 能完整表达一个孤立 property 的值域/插值，例如常见 transform、opacity、部分 paint scalar；它不把所属 Rive object 自动升级为完整支持。object 仍为 `partial`，直到其全部 properties、依赖关系和 runtime observable 通过 oracle。

## 必须补全的能力

### File、Artboard 与 Component

- `RIVE` header、ToC field typing、7.3 exact gate、unknown object/property early rejection。
- 多 Artboard、default artboard/state machine、Component/nested instance、simple/remap/mix、动态 Artboard property。
- fit/alignment/intrinsic size、instance recursion、late asset/reference resolution 与唯一 owner。
- 完整 `NeutralAnimationIR@1` inventory；source type/property key 只在 provenance side table。

### Vector、paint、image 与 compositing

- procedural paths 的所有可动画参数、多 fill/stroke、有序 effect group、fill rule、blend、clip 与 draw rule。
- gradient stop/transform/opacity、dash/trim、feather、image mesh、N-slice、solo/draw-order。
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

### Timeline、state machine 与 mixing

- every keyable property、step/linear/cubic/value interpolators、one-shot/loop/ping-pong、speed/reverse、nested remap/mix。
- entry/exit/any、single/1D/direct/additive blend、layer order、exit time/pause、ordered conditions/comparators、focus/listener actions。
- fixed timestamp ordering、seek/settle determinism、event emission exactly-once 和 per-channel ownership/mixing。

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
