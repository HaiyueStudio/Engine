# G01 acceptance record

状态：Accepted，初始日期：2026-08-22，revision 2/3 addendum 日期：2026-08-25，open issues：0。

本记录关闭 contract/review 工作，不声称 converter/runtime 已实现，也不把空的 G11 `formalAssets` 当作 release evidence。

## Requirement audit

| Requirement | Result | Evidence |
| --- | --- | --- |
| format/runtime/Editor export/features/renderer/decoder/script revisions | pass | `compatibility-tuple.json` 固定 7.3、source/public/internal heads、npm/WASM hashes、per-file Editor revision identity、flags/dependency tags 和 upgrade policy |
| generated object/property/script/asset census | pass | `runtime-census.json`：source 288/618/48/349/14；binary eligible 288/565/9；unclassified 0；generator deterministic；ADR 0088 修复 7 个 wrapped property case，ADR 0089 冻结 evidence eligibility，ADR 0092 要求自有 7.3 wire fixture parser replay 与官方 behavioral evidence 分责 |
| profiles and no semantic baking | pass | ADR 0087 + feature matrix 固定 `visual-baked`/`native-semantic`/`full-fidelity` eligibility |
| Accepted source-neutral ABI | pass | ADR 0087 固定 IR、semantics、neutral extension majors、budgets、package boundary |
| license matrix | pass | runtime/dependencies/content/Marketplace/self-owned/hosted/derived evidence 均有 decision 与 manifest rule |
| untrusted `.riv`/Luau/WGSL sandbox | pass | threat model 明确 ADR 0013 不适用，固定 isolation/capability/budget/owner controls |
| product/corpus/oracle/device plan | pass | corpus manifest + evidence plan 固定四个 product case、minimum corpus、trace channels 和 Windows matrix |
| no engine root expansion | pass | dependency boundary：focused subpaths/extensions only；browser closure deny-list |
| packed candidate/version policy | pass | dependency boundary 固定 clean build、`npm pack`、exact tarball hash、no source/file/range consumption |

## Review decisions

| Review | Decision | Open issue |
| --- | --- | ---: |
| architecture | Accepted：two-stage neutral IR；official runtime oracle/build-time only；no root API change | 0 |
| format/API | Accepted：exact 7.3；unknown strict fail；neutral majors and diagnostics frozen | 0 |
| security | Accepted contract：default-deny worker/process sandbox and hard budgets；implementation evidence owned by G02/G09/G11 | 0 |
| licensing | Accepted policy：code notices identified；all content remains per-asset gated；no unlicensed formal corpus admission | 0 |
| accessibility | Accepted：semantics/reduced motion is native observable and exact trace channel, never visual bake | 0 |
| evidence | Accepted：real product + isolated/adversarial/full oracle matrix frozen before implementation | 0 |

## Mechanical acceptance

- compatibility tuple id in generator and JSON matches。
- source/public commit and `.rive_head` match the fixed official archive；format constants are 7/3。
- every object/property/script entry has family、HYA status、Goal、diagnostic and fixture owner。
- duplicate object/property key count = 0。
- `unclassifiedObjects=0`、`unclassifiedProperties=0`、`unclassifiedScripts=0`。
- diagnostic catalog defines every code referenced by census。
- all eight census families have an implementation Goal G02–G09。
- deny-list forbids official Rive runtime and raw `.riv` from browser playback。

## Revision 2 addendum audit

- tuple/source/oracle identity 与 binary hashes 不变；`contractRevision=2`。
- frozen source 与官方素材 revision source 的可实例化 object/property 定义交叉检查为 288/618；后者 `.rive_head` 不与 2.40.0 oracle 对齐，因此没有被错误提升为新 tuple source。
- `565/677/856/861/862/863/978` 均可追溯到 frozen generated headers 与 `CoreRegistry`，漏记原因只是在 `Base::` 后换行。
- object key `526` 在两份官方 source 的 `makeCoreInstance`、generated headers 与 `dev/defs` 均不存在；固定 oracle 的 reader 将其作为 null object，完整消费字段后不进入 runtime graph。
- 只接受 `runtimeNullObjects=[526]`；其他 unknown object/property 仍 fail-closed。G02 必须保留 object budget、field budget 和独立 report，不能复制 opaque bytes 到 Neutral IR/HYA。

## Revision 3 coverage evidence audit

- tuple/source/oracle identity 不变；`contractRevision=3`。
- source census 仍完整登记 288/618/48/349/14，所有条目继续要求 owner/classification，不能因不可序列化而删除。
- generated `deserialize` case 机械给出 565 个 binary-eligible property；`CoreRegistry` 机械给出 9 个 binary-eligible asset type。53 个 runtime-only property 与 5 个非实例化 asset base 不得由 `.riv` 素材伪报覆盖。
- 48 个 module 与 349 个 symbol 是 behavioral capability ledger，不是 wire key；正式 closure 改由八个 feature-family workload、differential trace 与 security probe证明。
- upstream inventory breadth 与非 7.3 素材数量只保留为 diagnostic finding；实际 divergence、browser gate red case 或 unclassified failure 仍 fail-closed。

## No-go audit

No current contract-level no-go remains：format/source and oracle are reproducible；MIT code path is usable；content rights have a fail-closed admission process；a technically viable isolation contract exists；four product needs are fixed；census closes mechanically。

Implementation remains fail-closed。If G02 cannot parse 7.3 within budgets, G09 cannot demonstrate isolation, G11 cannot acquire licensed real assets/oracle evidence, or any family cannot preserve observables, M07 stays incomplete rather than shrinking the denominator。

## Handoff

G02 may implement only the frozen 7.3 reader/inventory/IR boundary。G03–G09 use census family/Goal ownership。Only G02/G13 may revise shared schema/exports/diagnostics/tuple；a leaf Goal discovering a contract gap must request a serial contract revision。
