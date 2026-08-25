# Product, corpus and official-oracle evidence plan

## Product admission

M07 is admitted for four real HaiYue workflows frozen in [`corpus-oracle-manifest.json`](./corpus-oracle-manifest.json)：AnimationEditor component import/reimport, data-driven game HUD, exported vector/rig loader, and sandboxed scripted custom control。Synthetic fixtures isolate features but do not replace these product combinations。

## Corpus layers

1. `format-version`：7.2/7.3/7.4/8.0, malformed header/ToC/varints and unknown keys。
2. `feature-isolated`：each census family and every object/property mapping rule；shared property keys use boundary/easing/animation fixtures。
3. `script-api`：all 48 modules/349 symbols, allowed/forbidden capabilities and typed protocol results。
4. `asset`：embedded/referenced/hosted font/image/audio/blob/script/shader plus replacement, missing, corrupt, license and URL cases。
5. `adversarial`：cycles, graph/decompression/list/event explosion, malicious font/media, infinite Luau, promise storm, output amplification, invalid/expensive WGSL, abort/device loss/late result。
6. `real-product`：the four frozen workflows with immutable Rive revision, bytes hashes, license provenance and transitive assets。
7. `combined-stress`：layout + data list + nested component + text + audio + interaction + script under resize/seek/reimport。

G11 owns content acquisition. `formalAssets` is intentionally empty at G01 and cannot be treated as release evidence；G01 freezes the schema, minimum counts and admission rules so later work cannot choose an easier corpus after implementation。

Official `rive-app` repository fixtures listed in [`official-asset-sources.md`](./official-asset-sources.md) are admissible remote inputs without copying their `.riv` bytes into this repository. A formal run materializes the exact commit/path URL in ephemeral storage, verifies byte length and SHA-256 before parsing, records source/license attribution, and removes the temporary input after the owner closes. The link and hash establish input identity only；the formal result still requires the complete frozen oracle/HYA workload and validated artifacts. Red results remain in the denominator。

## Oracle trace protocol

Each case records：

- tuple/oracle package hashes, asset/revision/resource hashes, browser/device, viewport/DPR, fonts and audio sample rate；
- exact artboard/animation/state-machine selection and initial data/resource instances；
- integer-microsecond clock steps and ordered input/data/resize/resource/semantic actions；
- official runtime and HYA traces from fresh owners with identical action stream；
- pixels plus geometry/draw order, state/data/events, focus/input routing, audio schedule, semantic tree/actions, diagnostics and owner residual。

The official oracle may render/load successfully while HaiYue strict import fails on unknown/new semantics；oracle success never overrides the frozen census or profile eligibility。

## Comparison rules

| Channel | Formal comparison |
| --- | --- |
| object/property coverage | exact key sets；unclassified/missing fixture owner = 0 |
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

- Windows 10 22H2, integrated Intel-class GPU, Chrome stable and Edge stable；
- current Windows 11, discrete NVIDIA-or-AMD-class GPU, Chrome stable and Edge stable。

Both require WebGL2 official oracle and WebGPU HYA runtime, audio output/schedule capture, keyboard/gamepad/focus, accessibility bridge and resize/DPR coverage。Other platforms may provide diagnostic evidence but do not expand the Accepted claim without a tuple addendum。

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
