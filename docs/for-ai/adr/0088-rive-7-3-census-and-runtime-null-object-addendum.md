# ADR 0088：修正 Rive 7.3 property census 并显式冻结 runtime-null object

- 状态：Accepted
- 日期：2026-08-25
- 补充：ADR 0087
- 兼容 tuple：`rive-7.3-webgl2-2.40.0`，contract revision 2

## 背景

G11 的 hash-pinned 官方输入暴露出两个 strict importer 拒绝：ToC property key `565` 与 object type key `526`。核查冻结 source 后确认它们不是同一种兼容变化。

原 census 生成器只匹配单行 `case OwnerBase::propertyPropertyKey:`。官方 generated `CoreRegistry` 会在 `Base::` 后换行，导致 7 个既有 property case 未进入 census。`565` 从冻结 source 起就是 `ViewModelPropertyViewModel.viewModelReferenceId`，wire kind 为 `uint`，并非新 exporter schema。

`526` 则不在冻结 source 或官方素材所在 `3f4047a85f11fecfde8c4d906c0c1654aa12b015` source 的 `CoreRegistry::makeCoreInstance`、generated type headers 或 `dev/defs` 中。官方 reader 对这类 key 的行为是：`makeCoreInstance` 返回 null，仍按 `CoreRegistry::propertyFieldId` 或文件 ToC 消费字段，随后向 importer stack 报告 null object；它不会进入 runtime object graph。固定的 `@rive-app/webgl2@2.40.0` 在 Chrome 与 Edge 均以该路径加载了 hash-pinned `game_menu_ad_police_files.riv`。

## 决策

### 1. tuple 身份不变，contract revision 升为 2

format、runtime source、`.rive_head` 与 official oracle 都保持 ADR 0087 的固定值。`rive-runtime@3f4047…` 的 288 个可实例化 object 与修正后的 618 个 property 定义同冻结 schema 一致，但其 `.rive_head=584f66bc955f9f163c2b11158e46063c91f01535` 不与 `webgl2@2.40.0` 对齐；它只作为官方素材 revision 和交叉检查源，不能替换 tuple source。

### 2. property census 修正为 618

生成器必须把 `Base::` 后的任意生成式空白视为同一 case label。修正后新增到既有分母的 7 项为：

| Key | Owner | Property |
| ---: | --- | --- |
| 565 | `ViewModelPropertyViewModel` | `viewModelReferenceId` |
| 677 | `TransitionPropertyArtboardComparator` | `propertyType` |
| 856 | `ArtboardComponentListOverride` | `instanceWidthUnitsValue` |
| 861 | `ArtboardComponentListOverride` | `instanceHeightUnitsValue` |
| 862 | `ArtboardComponentListOverride` | `instanceWidthScaleType` |
| 863 | `ArtboardComponentListOverride` | `instanceHeightScaleType` |
| 978 | `TransitionPropertyComponentComparator` | `propertyKey` |

这 7 项是 census extraction correction，不是 upstream schema delta。object、script 与 asset totals 保持 288/48/349/14（9 serialized）。

### 3. 只允许显式 runtime-null object key `526`

tuple 增加 `runtimeNullObjects` allowlist，当前唯一条目为 `526`。G02 reader 必须：

- 将它计入输入 object budget 与独立 `runtimeNullObjects` report，不创建 Neutral IR object，不改变 artboard/component hierarchy或引用编号；
- 完整消费每个字段；字段 key 必须属于修正后的 frozen property registry 或文件 ToC，wire kind 必须可证明且 payload 必须通过同一长度、working-set 与格式预算；
- 不得把其 bytes、Rive key 或 opaque payload复制到 HYA；
- 对 `526` 以外的未知 object 继续 `E_RIVE_UNKNOWN_OBJECT`，对未知/无类型字段继续 fail-closed。

这是对固定官方 runtime null-object 语义的逐 key实现，不是 unknown-object 宽松加载。若未来 oracle 为 `526` 产生 runtime object、observable 或不同 field typing，必须建立新 tuple。

### 4. full-fidelity 分母仍是 runtime observables

`runtime-null` 表示固定 oracle 明确不 materialize、无 runtime observable；它不是 `unsupported`，也不计入 288 个可实例化 object coverage。正式证据必须同时记录其出现次数与 key，防止它被静默遗漏。任何可实例化 object/property/script/asset 仍必须进入 census、Neutral IR mapping 与 differential trace。

## 后果

- tuple id、source/archive/oracle binary hashes 均不变；contract revision 与 census digest 改变。
- G02 必须重新生成 frozen registry，property coverage denominator 改为 618，并新增 `526` 的 isolated/adversarial reader fixtures。
- 现有文档或 evidence 中的 `/611` 都必须刷新；历史运行记录可保留旧 denominator，但不能冒充 revision 2 结果。
- ADR 0087 的任意 unknown strict-fail 原则继续有效，只有 tuple 中逐项 Accepted 的 runtime-null allowlist 是例外。

