# ADR 0089：Rive coverage 分离 source census、binary evidence 与 behavioral evidence

- 状态：Accepted
- 日期：2026-08-25
- 补充：ADR 0087、ADR 0088
- 兼容 tuple：`rive-7.3-webgl2-2.40.0`，contract revision 3

## 背景

G11 revision 1 把 G01 source census 的全部 288/618/48/349/14 项都当作正式 `.riv` 素材必须逐 key 遇到的 wire coverage。这混合了三种不同事实：generated source 定义、可出现在 `.riv` 中的 key，以及只能通过运行行为观察的脚本 capability。

冻结 source 的 618 个 property key 中，565 个具有 generated `deserialize` case，可由 `.riv` wire payload赋值；其余 53 个是计算值或 runtime-only setter，没有合法序列化 payload。14 个 asset definition 中只有 9 个进入 `CoreRegistry::makeCoreInstance`；其余 5 个是非实例化基类。48 个 Luau registration module 与 349 个注册 symbol 是 runtime source capability，不是 `.riv` property/object key。要求正式素材“遇到”后三类 source-only 项既不可实现，也会诱导伪造 coverage 数组。

## 决策

### 1. tuple 身份不变，contract revision 升为 3

format 7.3、runtime source commit、`.rive_head`、oracle `@rive-app/webgl2@2.40.0`、object/property/source totals 与 ADR 0088 的 runtime-null key `526` 均不改变。本修订只冻结 evidence eligibility，不缩小支持能力或 source classification 分母。

### 2. source census 继续完整分类

G01 source census 仍为：288 个 registry-instantiable object、618 个 property definition、48 个 script module、349 个 script symbol 与 14 个 generated asset definition。所有条目必须有 family、Goal、status、diagnostic 与 fixture owner，`unclassified*=0`。source-only 项不能删除、隐藏或计作已由素材覆盖。

### 3. binary evidence 只接受可序列化 key

G11 `.riv` encounter coverage 的固定分母为：

| 类别 | Source census | Binary eligible | Source-only |
| --- | ---: | ---: | ---: |
| Object type | 288 | 288 | 0 |
| Property key | 618 | 565 | 53 |
| Asset type | 14 | 9 | 5 |

binary eligibility 必须由冻结生成源码机械产生：object/asset 必须进入 `CoreRegistry::makeCoreInstance`，property 必须具有 generated `deserialize` case。正式素材不得声称覆盖 source-only property 或 asset base。runtime-null `526` 不属于 288 object 分母，继续按 ADR 0088 独立报告。

### 4. script coverage 是 behavioral evidence

48 个 module 与 349 个 symbol 保留为 source capability ledger，用来驱动 G09 owner mapping、probe 生成和未分类检查；它们不进入 `.riv` wire-key uncovered count。正式 closure 必须以 `scripting-custom-rendering` feature-family workload、revision-pinned capability evaluation、官方/HYA differential trace 和 sandbox/security probe 证明行为。仅在 manifest 中列出 module/symbol 名称不能替代行为证据。

八个 G02–G09 feature family 都必须具有正式 behavioral witness。缺失 family、trace red case、未分类脚本 capability 或 owner mapping 缺失继续阻止 G11/G13。

### 5. upstream inventory breadth 是诊断，不是准入阈值

冻结 upstream fixture inventory 的覆盖比例，以及其他 repository 中不属于 7.3 denominator 的素材数量，保留为不可变 diagnostic finding。它们本身不产生 blocker；只有由 inventory 揭示的 importer/oracle divergence、browser gate failure、classified red case 或 unclassified failure 才阻止准入。

## 后果

- runtime census 增加逐项 `binaryEvidenceEligible`、property `serialized`、evidence class，以及 565/53、9/5 totals。
- G11 corpus validator 分别报告 source classification、binary uncovered 与 behavioral family uncovered；script module/symbol attribution 不再伪装成 wire coverage。
- G11 candidate coverage contract revision 升为 2。旧 candidate 可作为历史诊断，但不能晋升 formal evidence。
- 本修订不会把当前 G11 标为完成：151 个 binary object、292 个 binary property、9 个 binary asset type、3 个 behavioral family 仍未覆盖，differential trace、设备与 closure 仍必须真实运行。
