# ADR 0087：Rive 以不可信 build-time source 转换为来源无关 HYA

- 状态：Accepted
- 日期：2026-08-22
- 兼容 tuple：`rive-7.3-webgl2-2.40.0`

## 背景

M07 要把 Rive runtime `.riv` 资产转换为 HYA。当前 HYA 1.0 已有节点变换、sprite/path、部分 vector paint/morph、text/audio、sampled deformable mesh 和基础状态机，但 Rive 7.3 还包含多 Artboard/Component、参数化 rig、constraints、responsive layout、View Model/Data Binding、listeners/events、audio schedule、semantics、Luau protocols 与 custom WGSL。

`.riv` 是面向官方 runtime 的二进制格式。官方 runtime 对同 major 的未知新 field 可以跳过，但这种行为只能保证旧 runtime 尽量加载，不能证明 HaiYue 保留了语义。把 `.riv`、官方 WASM 或 Rive object model 原样带入页面也会违反 HYA 来源无关、可卸载能力和浏览器闭包边界。

## 决策

### 1. 固定兼容分母

唯一 Accepted 分母由 [`rive-hya/compatibility-tuple.json`](../rive-hya/compatibility-tuple.json) 定义：

- fingerprint `RIVE`，format major/minor `7.3`；formal `full-fidelity` 输入必须精确匹配。
- source 为 `rive-app/rive-runtime@526625850eaf34fc1263d181808ffca10cae6ac1`，`.rive_head=ee809ba7f032271dd7102f17afe3baf9d192435b`。
- differential oracle 为固定哈希的 `@rive-app/webgl2@2.40.0` JS/WASM。
- 每个正式 Editor export 以 Rive cloud file revision id 加导出 bytes SHA-256 标识；mutable link 或“最新版 Editor”不是 revision。

未来 minor/major、object/property、Luau API 或 asset kind 不自动进入支持范围。升级必须重新生成 census、补 delta fixtures、重跑安全/许可/oracle/闭包审查，并接受 superseding decision。

### 2. 完整性由生成 census 定义

[`runtime-census.json`](../rive-hya/runtime-census.json) 由冻结 source 的 `CoreRegistry`、generated headers 和 Lua registration source 机械生成。经 [ADR 0088](./0088-rive-7-3-census-and-runtime-null-object-addendum.md) 修正后，本 tuple 包含 288 个可实例化 runtime object、618 个唯一 runtime property key、48 个 Lua registration module、349 个注册 symbol 和 14 个 `generated/assets/` type definition（其中 9 个进入 `CoreRegistry` 可序列化 object）。View Model/bindable asset references 仍作为普通 object/property 逐项登记，不重复计入 file asset 汇总。ADR 0088 另冻结一个不进入 runtime graph 的逐 key `runtime-null` object；它不计入可实例化 object census。

每项必须拥有：family、当前 HYA `full|partial|missing`、实现 Goal、strict diagnostic 和 fixture owner。生成器对重复 key 或未分类条目失败。reader 遇到 census 之外的 object/property/script/asset 必须在 materialization/执行之前失败；唯一例外是 compatibility tuple 逐 key接受的 `runtime-null` object，它必须完整消费、计数和报告但不 materialize，不能扩展成任意 unknown 跳过。

### 3. 三个兼容 profile

- `visual-baked`：只允许确定性、无输入/数据/layout resize/event/audio/semantic/script/resource replacement observable 的纯视觉子图。必须有自适应采样、极值覆盖和误差证据。
- `native-semantic`：保留来源无关的 timeline、state machine、rig、layout、data、interaction、events、audio、semantics、resource replacement 和 sandbox protocol。
- `full-fidelity`：整份资产的每个 observable 都为 `native-semantic`，或纯视觉局部满足 `visual-baked`。任一 unknown、unsupported、budget excess、license gap 或 oracle mismatch 都失败。

把交互状态穷举为 clips、把响应布局固定尺寸、把动态文本转图、把 list 截断、把事件/audio/semantics 丢弃、把 script 输出录屏，都不是 full-fidelity。

### 4. 两段式来源无关导入

边界固定为：

```text
untrusted .riv + external assets
  → version/budget/rights gate
  → Rive reader/evaluator adapter (build-time only)
  → NeutralAnimationIR@1
  → HYA compiler + attribution/provenance report
  → HYA 1.0 + required neutral extensions
```

`NeutralAnimationIR@1` 至少包含 `artboards`、`instances`、`nodes`、`drawables`、`resources`、`rigs`、`constraints`、`layouts`、`timelines`、`stateMachines`、`dataModels`、`interactions`、`events`、`audioSchedules`、`semantics` 与 `sandboxPrograms`。Rive type/property id 只允许进入独立 provenance side table；不得成为 HYA id、extension field、runtime switch 或 Editor project ABI。

adapter 删除后，生成 HYA 必须仍能被通用 HaiYue runtime 播放和验证。official runtime/WASM 只可用于 build-time evaluator 或 test oracle，不得成为 `@haiyue/animation-spec` root dependency。

### 5. 冻结语义

- 坐标：IR/HYA 使用 CSS-pixel-like canvas units、`screen-y-down`；2D affine transform 顺序显式保存。rotation 归一为 radians，正方向按 y-down 画布的 clockwise visual rotation。
- 颜色：IR 保存 unpremultiplied sRGB RGBA `[0,1]`；插值按 source property 语义，renderer 边界才 premultiply。gradient stop order、spread、opacity 和 paint order 不合并。
- path/paint/composite：fill rule、stroke cap/join/miter/dash、trim、feather、clip、blend 和 draw order 均为可观察语义；不支持的 blend/effect 不近似。
- 时间：IR 使用 finite seconds；oracle driver 使用整数 microseconds。相同 timestamp 按 source layer/order/sequence 稳定排序。seek 必须从确定 snapshot settle，不能依赖之前帧历史。
- event/audio：事件保存 timestamp、phase、target、payload、source order；audio 保存 clock domain、sample offset、rate、gain、loop 和 owner。像素相等不能替代 event/audio trace。
- data：View Model mutation 是有序 transaction；list identity、nested model、enum domain、resource/artboard replacement 和 observation timing 都保留。
- layout：viewport、DPR、intrinsic size、font metrics、min/max/hug/fill、overflow/scroll 和 virtualization 输入明确；resize 后由同一输入决定同一 tree/geometry。
- script：只保存 source-neutral protocol id、typed ports、declared capabilities、validated program artifact 与 budgets。不得把任意 Luau/WGSL 当作普通 HYA data 在主线程/主 device unrestricted 执行。

### 6. 扩展 major

HYA core 继续为 `haiyue-animation@1.0`。已有 `org.haiyue.vector-shape@1` 保持不变；M07 所需 neutral majors 固定为：

- `org.haiyue.deformable-mesh-2d@2`
- `org.haiyue.layout-2d@1`
- `org.haiyue.animation-state-machine@2`
- `org.haiyue.interaction@1`
- `org.haiyue.data-binding@1`
- `org.haiyue.semantics@1`
- `org.haiyue.audio-events@1`
- `org.haiyue.sandboxed-animation-script@1`

这些名称不含 Rive。实现中若契约无法表达 frozen census，必须在 G02/G13 串行修改 major 决策，不能加 Rive 专属 escape hatch。

### 7. 不可信输入与 hard budgets

`.riv`、Luau byte/source、WGSL、font、image、audio、compressed texture 和 URL 全部是不可信输入。ADR 0013 的 trusted-project JavaScript capability 不适用。完整 threat model 见 [`threat-model.md`](../rive-hya/threat-model.md)。G02/G09 至少执行以下 hard limits；超限不产生部分 HYA：

| 资源 | 默认上限 |
| --- | ---: |
| `.riv` bytes / decoded working set | 64 MiB / 512 MiB |
| objects / property assignments / reference depth | 250,000 / 4,000,000 / 128 |
| artboard instances / list items / event recursion | 8,192 / 100,000 / 64 |
| UTF-8 string / total text | 4 MiB / 32 MiB |
| external assets / one asset / total resolved bytes | 4,096 / 256 MiB / 1 GiB |
| image dimension / decoded pixels | 16,384 / 268,435,456 |
| vertices / keyframes / draw items | 5,000,000 / 10,000,000 / 1,000,000 |
| import wall time | 60 s, abortable |
| sandbox program / VM heap / call depth | 1 MiB / 16 MiB / 128 |
| script instruction budget | 1,000,000 per tick and 10,000,000 per import evaluation |
| WGSL source / bindings / textures / storage bytes | 256 KiB / 32 / 16 / 64 MiB |

任何放宽都必须是显式 option、记录 attribution，并仍受全局 hard ceiling；formal corpus 用默认值。

### 8. 包与浏览器边界

- source-neutral model/codec 位于 `@haiyue/animation-spec` focused subpaths；build-time adapter 为 `@haiyue/animation-spec/rive`。
- 完整可选 runtime 位于 focused `@haiyue/extensions/*`；不修改 `@haiyue/engine` root，不让 foundation workspace 依赖 extensions/Editor。
- Editor 只消费发布版本或 `npm pack` candidate；禁止跨仓 source/file dependency。
- official Rive package/source、`.riv`、Luau VM 和 Rive renderer 不进入 HYA browser player。闭包按 [`browser-runtime-deny-list.json`](../rive-hya/browser-runtime-deny-list.json) 扫描 package、bundle、source map、static strings 和 network。

### 9. 许可与证据

runtime/source/generated code 的 MIT 许可不授予 Marketplace artwork、字体、图片、音频或 hosted asset 的再分发权。每个 corpus/转换输入必须按 [`license-matrix.md`](../rive-hya/license-matrix.md) 独立记录权利和 obligations；缺失 provenance 即 strict fail/不进入正式证据。

完整性以官方 runtime trace 为 differential oracle，覆盖 pixels、geometry/draw order、state/data/event、input/focus、resize、audio schedule、semantic tree、resource replacement、errors 和 owners。只比较截图不构成 full-fidelity。

## 后果

- M07 是通用 HYA 能力补全，不是一个 Rive-only converter。
- 当前 census 中大量 family 为 partial/missing；G03–G09 可以据此独立实现，但不能改变 shared contract。
- full-fidelity 对未来 Rive 更新默认关闭，避免把 unknown-field 宽松加载误报为完整支持。
- build-time 可能承担较大 evaluator/decoder 成本，但发布页面闭包保持来源无关且可审计。

## 拒绝的方案

- 在 HYA 中嵌入 `.riv` 并调用官方 WASM：违反来源无关和 browser closure。
- 只遍历已知对象、忽略 unknown property：无法证明完整性。
- 对所有视觉结果统一逐帧烘焙：丢失交互、数据、layout、events、audio、semantics 和 scripts。
- 在主线程或 trusted-project realm 执行 Rive Luau/WGSL：威胁模型与 ADR 0013 不兼容。
- 宣称支持“当前最新版 Rive”：不可复现，也无法定义回归分母。
