# Product, corpus and official-oracle evidence plan

## Product admission

M07 is admitted for four real HaiYue workflows frozen in [`corpus-oracle-manifest.json`](./corpus-oracle-manifest.json)：AnimationEditor component import/reimport, data-driven game HUD, exported vector/rig loader, and sandboxed scripted custom control。Synthetic fixtures isolate features but do not replace these product combinations。

## Corpus layers

1. `format-version`：7.2/7.3/7.4/8.0, malformed header/ToC/varints and unknown keys。
2. `feature-witness` evidence role：each census family and every object/property mapping rule；one immutable official asset may carry several independently named roles, and shared property keys use boundary/easing/animation roles。
3. `script-api`：all 48 modules/349 symbols 的 source owner/classification ledger，以及覆盖八个 feature family 的 allowed/forbidden capability probe 与 typed protocol results；module/symbol 名称不是 `.riv` wire coverage。
4. `asset`：embedded/referenced/hosted font/image/audio/blob/script/shader plus replacement, missing, corrupt, license and URL cases。
5. `adversarial`：cycles, graph/decompression/list/event explosion, malicious font/media, infinite Luau, promise storm, output amplification, invalid/expensive WGSL, abort/device loss/late result。
6. `product-witness` evidence role：the four frozen workflows with immutable Rive revision, bytes hashes, license provenance and transitive assets；a product role does not require a duplicate `.riv` when an admitted official asset covers its required families and actions。
7. `combined-stress`：layout + data list + nested component + text + audio + interaction + script under resize/seek/reimport。

G11 owns content acquisition. `formalAssets` is intentionally empty at G01 and cannot be treated as release evidence；G01 freezes the schema, minimum counts and admission rules so later work cannot choose an easier corpus after implementation。

Official `rive-app` repository fixtures listed in [`official-asset-sources.md`](./official-asset-sources.md) are admissible remote inputs without copying their `.riv` bytes into this repository. A formal run materializes the exact commit/path URL in ephemeral storage, verifies byte length and SHA-256 before parsing, records source/license attribution, and removes the temporary input after the owner closes. The link and hash establish input identity only；the formal result still requires the complete frozen oracle/HYA workload and validated artifacts. Red results remain in the denominator。

## Oracle trace protocol

Each case records：

- tuple/oracle package hashes、三个 production adapter revision descriptor、asset/revision/resource hashes、由 official/HYA capture 共同确认的 browser/device、viewport/DPR、fonts 和 audio sample rate；
- exact artboard/animation/state-machine selection and initial data/resource instances；
- integer-microsecond clock steps and ordered input/data/resize/resource/semantic actions；
- official runtime and HYA traces from fresh owners with identical action stream；
- pixels plus geometry/draw order, state/data/events, focus/input routing, audio schedule, semantic tree/actions, diagnostics and owner residual。

The official oracle may render/load successfully while HaiYue strict import fails on unknown/new semantics；oracle success never overrides the frozen census or profile eligibility。

## Comparison rules

| Channel | Formal comparison |
| --- | --- |
| source census coverage | 288/618/48/349/14 全量 owner/classification；unclassified/missing fixture owner = 0 |
| binary evidence coverage | exact 288 object / 565 serialized property / 9 serialized asset key sets |
| behavioral evidence coverage | 八个 feature family workload；script registration 由 capability/security trace而不是 wire-key encounter证明 |
| transforms/geometry/layout | stable topology/order；finite values；absolute error ≤ `1e-4` canvas unit after normalized coordinate conversion |
| colors/paint | semantic paint/blend/clip structure exact；normalized channel error ≤ `1/1024` before rasterization |
| pixels | same device/browser fixed DPR；max channel delta ≤ `2/255`, changed pixels ≤ `0.1%`, SSIM ≥ `0.9995`；any structural/state difference fails regardless of score |
| time/state/data/event/input | exact integer-microsecond timestamp/order/target/value/identity after documented normalization |
| audio | exact event/voice/sample-offset/rate/gain/loop schedule；waveform is secondary decoder evidence |
| semantics | exact role/name/value/state/action/navigation tree after platform bridge normalization |
| scripts/WGSL | exact typed commands/capability decisions/resource accounting；no ambient outputs |
| lifecycle | owner residual = 0 after normal, error, abort, reimport, close and device-loss paths |
| determinism | same input/options/concurrency produces byte-identical HYA/package/report, excluding explicitly external evidence timestamps |
| browser closure | every deny-list count = 0 |

Tolerance changes require review and cannot be made in the same change that promotes failing evidence/baselines。

## Browser/device matrix

Formal first-release evidence follows the existing Windows-first support policy：

- `windows-10-plus-device-a`：任意 Windows 10 或更高版本物理机器与真实 GPU，Chrome stable 和 Edge stable；
- `windows-10-plus-device-b`：另一台任意 Windows 10 或更高版本物理机器与真实 GPU，Chrome stable 和 Edge stable。

两台机器的 `machineIdSha256` 必须不同；不再要求指定集显/独显类别。两者都要求 WebGL2 official oracle 和 WebGPU HYA runtime、浏览器日志采集且 console error/exception 为 0、audio output/schedule capture、keyboard/gamepad/focus、accessibility bridge 和 resize/DPR coverage。正式 Node runner 接受任意 Node.js major `>=22`。其他平台可提供 diagnostic evidence，但不扩展 Accepted claim。

## Reports and gates

One candidate report binds a clean Engine revision, packed package hashes, Editor revision, corpus manifest hash and all artifacts。It contains：

- census/fixture/diagnostic coverage；
- format/API/boundary/packed-consumer checks；
- differential traces and approved pixel artifacts；
- CPU/GPU/memory/network/parse/first-frame/raw/gzip metrics；
- security budget/escape/URL/decoder results；
- accessibility/audio and lifecycle owner results；
- package/bundle/source-map/network closure scan；
- license/provenance/attribution inventory。

Smoke/diagnostic runs never replace formal evidence。Formal evidence requires the full workload, required real devices, current clean revision and artifact validator。

正式执行把 trace、security、browser closure、index、candidate 与 closure-attempt 写入 Git 已忽略的 `artifacts/rive-g11-formal/`。这样写 artifact 不会改变被测 source revision 或 clean-worktree 身份；最终记录通过 SHA-256/byte length 绑定实际 bytes，不能用受跟踪的 diagnostic candidate 替代。需要长期留存时，应把整个目录作为不可变 CI/review artifact 上传，并以报告内的 `engineRevision` 作为被测 revision。
