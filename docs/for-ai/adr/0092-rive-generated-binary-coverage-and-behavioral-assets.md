# ADR 0092：Rive binary wire coverage 与官方 behavioral evidence 分离

- 状态：Accepted
- 日期：2026-08-27
- 补充：ADR 0087、ADR 0089、ADR 0090
- 兼容 tuple：`rive-7.3-webgl2-2.40.0`

## 背景

ADR 0089 已把 source census、可序列化 binary evidence 与 behavioral evidence 分开，但 G11 corpus revision 仍把全部 binary key 的 encounter closure 只归给 `formalAssets`。冻结官方仓库中的 35 个可接受 7.3 输入联合只能遇到 145/288 object key、296/565 property key；当前八个 behavioral asset 为 137/288、273/565、5/9 asset type。继续增加官方素材也无法覆盖冻结分母，并会无意义地扩大素材 × 设备 × 浏览器 workload 矩阵。

## 决策

1. G11 增加一个 HaiYue 自有、确定性生成、仓库固定的 format 7.3 `binaryCoverageCorpus`。生成器从冻结 registry 取 288 个 object、565 个 serialized property 与 9 个 serialized asset type，构造真实 `.riv` bytes，并立即用 `readFrozenRiv` 重放；只有实际 encounter 集与冻结分母完全一致才允许写出 index。
2. index 必须固定 generator id、tuple、registry identity、fixture path、SHA-256、byte length、MIT 权利声明和 parser replay coverage。manifest 再固定 index 身份；任一 bytes、key 或生成器漂移均使 corpus contract 失败。
3. `binaryCoverageCorpus` 只证明 wire parser 对合法 key/wire-kind 的 encounter closure。它不能承担 feature witness、product witness、combined stress、官方 oracle/HYA differential trace、物理设备 performance 或 browser closure。
4. `formalAssets` 继续由官方不可变素材承担八个 behavioral family 与产品工作流。一个官方素材仍可承担多个 evidence role；完整 workload、production adapter、双设备 Chrome/Edge 和所有 oracle channel 要求不变。
5. 官方素材中观察到的 object/property attribution 继续记录，用于审计真实输入广度，但不再决定 binary denominator 是否闭合。

## 后果

- binary coverage blocker 可由一个 3047-byte、可重现并经 parser replay 的自有 7.3 fixture 正式闭合，不需要 vendoring 官方素材。
- corpus formal validation 仍会因八个 behavioral asset 未达到 `trace-ready`、缺失 production differential trace、设备、performance、security 或 closure evidence 而失败；generated fixture 不会把这些红项染绿。
- tuple 的格式版本、runtime/exporter revision、oracle package 与 288/565/9 分母均未改变，本 ADR 只修正 evidence source 的职责边界。
