# ADR 0094：paint-local vector Feather 使用可追加、来源无关的 HYA 契约

- 状态：Accepted
- 日期：2026-09-05
- 补充：ADR 0087
- 兼容 tuple：`rive-7.3-webgl2-2.40.0`

## 背景

`org.haiyue.vector-shape@1` 原有 compact binary index 11 只能表达 `innerFeather.radius/offset`。它不能区分 outer Feather，也不能保存 local/world space；G10 production lowering 因而只把 gradient inner Feather 接入通用九点模糊，solid inner Feather 降为描边代理，并丢失 outer Feather。这些做法改变 paint、bounds 与 compositing 的可观察结果，不满足 ADR 0087 的 full-fidelity 约束。

G03 的 `haiyue-vector-visual@1` 已把 Feather 定义为来源无关的 `radiusX/radiusY/offsetX/offsetY/inner/space` effect。可播放 HYA 必须保存同一语义，而不是加入 Rive object id、原始字段或 runtime 分支。

## 决策

1. `AnimationVectorShapeComponent` 增加 paint-local `feather`：`radius`、可选 `offset`、必需 `inner` 和可选 `space: local|world`。半径、偏移均使用 animation canvas unit；`space` 缺省为 `local`。
2. compact vector component 在末尾追加 index 12：`[radius, offset|0, inner(0|1), space(0|1)]`。旧 index 11 `innerFeather` 继续读取和编码，保证既有 HYA 可重放；新 converter 只写 index 12。两者同时出现是格式错误，避免优先级歧义。
3. JSON 与 binary 两条入口都验证 finite 数值、至少一个正半径轴和每轴 `4096` hard ceiling。unknown mode、非法布尔索引及同时声明两种字段必须在 runtime 分配前失败。
4. production adapter 对 fill 与 stroke 的 solid/gradient paint 一律保存 Feather。只有 fill 可以为 inner；stroke 的 authored inner 标记按官方 `isInner()` 语义规范为 outer。省略 strength 使用冻结 Rive 7.3 默认值 `12`，`spaceValue=1` 映射为 world，其余冻结值为 local。
5. WebGPU runtime 把新字段作为独立 paint effect 执行，且不影响同一 shape stack 的 sibling paint。local 半径/偏移随对象 transform，world 半径/偏移只随 canvas/view transform。旧 index 11 保持原 inner-only 呈现路径。
6. full-fidelity renderer 的完成条件仍是 effect-path、inner clip、outer bounds、三标准差 Gaussian coverage 与角点积分对固定官方 oracle 的像素通过。临时卷积实现只能标记为 `partial`，不得借本 ADR 宣称 Inventory paint blocker 已关闭。

## 后果

- converter 不再需要 solid stroke proxy，也不再静默丢弃 outer/world Feather。
- HYA major、extension id 和旧 binary index 均不改变；删除 Rive adapter 后，新产物仍只依赖来源无关 contract。
- runtime 需要继续把当前 view-sized blur 收敛为轮廓级 analytic coverage；在正式 differential 通过前，feature corpus 的 vector Feather 状态保持 `partial`。

## 拒绝的方案

- 复用 layer blur：会同时改变 sibling paint，且无法表达 inner clip 与 world space。
- 为 Rive 新增专用 component/effect：违反来源无关 HYA 边界。
- 把 solid Feather 转成 stroke：改变内部 coverage、paint order 与透明度。
- 只提高卷积采样数：没有 effect-path 与角点积分，不能证明与固定 oracle 等价。
