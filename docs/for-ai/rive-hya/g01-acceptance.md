# G01 acceptance record

状态：Accepted，日期：2026-08-22，open issues：0。

本记录关闭 contract/review 工作，不声称 converter/runtime 已实现，也不把空的 G11 `formalAssets` 当作 release evidence。

## Requirement audit

| Requirement | Result | Evidence |
| --- | --- | --- |
| format/runtime/Editor export/features/renderer/decoder/script revisions | pass | `compatibility-tuple.json` 固定 7.3、source/public/internal heads、npm/WASM hashes、per-file Editor revision identity、flags/dependency tags 和 upgrade policy |
| generated object/property/script/asset census | pass | `runtime-census.json`：288/611/48/349/14（9 serialized）；unclassified 0；generator deterministic |
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

## No-go audit

No current contract-level no-go remains：format/source and oracle are reproducible；MIT code path is usable；content rights have a fail-closed admission process；a technically viable isolation contract exists；four product needs are fixed；census closes mechanically。

Implementation remains fail-closed。If G02 cannot parse 7.3 within budgets, G09 cannot demonstrate isolation, G11 cannot acquire licensed real assets/oracle evidence, or any family cannot preserve observables, M07 stays incomplete rather than shrinking the denominator。

## Handoff

G02 may implement only the frozen 7.3 reader/inventory/IR boundary。G03–G09 use census family/Goal ownership。Only G02/G13 may revise shared schema/exports/diagnostics/tuple；a leaf Goal discovering a contract gap must request a serial contract revision。
