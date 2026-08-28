# Rive → HYA full-fidelity contracts

本目录冻结 M07 的 Rive 兼容分母。它描述的是 build-time `.riv` 导入与来源无关 HYA 能力，不是把 Rive runtime 加入 HaiYue 页面播放闭包。

## 阅读顺序

1. [ADR 0087](../adr/0087-rive-hya-source-neutral-full-fidelity.md) 与 [ADR 0088](../adr/0088-rive-7-3-census-and-runtime-null-object-addendum.md)：Accepted 架构、census 修正与 runtime-null 边界。
2. [compatibility-tuple.json](./compatibility-tuple.json)：唯一受支持的官方格式/source/oracle 修订。
3. [feature-gap-matrix.md](./feature-gap-matrix.md)：当前 HYA 与完整 Rive family 的能力差距。
4. [runtime-census.json](./runtime-census.json)：从冻结 source 生成的逐 object/property/script/asset census。
5. [diagnostic-catalog.md](./diagnostic-catalog.md)：strict 失败协议。
6. [threat-model.md](./threat-model.md) 与 [license-matrix.md](./license-matrix.md)：不可信执行与内容权利边界。
7. [dependency-boundary.md](./dependency-boundary.md) 与 [browser-runtime-deny-list.json](./browser-runtime-deny-list.json)：包边界和浏览器闭包。
8. [corpus-oracle-manifest.json](./corpus-oracle-manifest.json)、[official-asset-sources.md](./official-asset-sources.md) 与 [evidence-plan.md](./evidence-plan.md)：产品 case、官方远程输入、corpus、oracle 和设备证据。
9. [g01-acceptance.md](./g01-acceptance.md)：G01 的逐项审查结论。

可执行视图：`examples/rive-feature-corpus` 把完整 1317 条 census 投影成可搜索页面；`examples/rive-hya-compare` 在右侧运行固定 hash 的官方 WebGL2 oracle，并只在左侧输入的 HYA 与 conversion report 同时绑定当前 RIV/HYA SHA-256 后才显示 HaiYue WebGPU 结果。两者的数据均由 `npm run rive:examples:data` 从本目录 census 与正式 corpus manifest 生成。

`tools/` 只保存 census 的可复现生成器；生成结果本身受兼容 tuple 和 source digest 约束。

## 冻结结论

- `.riv` denominator：fingerprint `RIVE`、format `7.3`。
- 官方 source：`rive-app/rive-runtime@526625850eaf34fc1263d181808ffca10cae6ac1`，其 `.rive_head` 为 `ee809ba7f032271dd7102f17afe3baf9d192435b`。
- differential oracle：`@rive-app/webgl2@2.40.0` 的固定 npm tarball/WASM。
- census：source ledger 为 288 个可实例化 runtime object、618 个 runtime property definition、48 个 Luau 注册模块、349 个注册 symbol、14 个 asset type definition；binary-evidence 分母为 288 objects / 565 serialized properties / 9 serialized assets；所有分类计数均为 0。另有 tuple 逐项接受、独立报告且不 materialize 的 runtime-null object key `526`。
- `full-fidelity` 只对该 tuple 成立。未来 minor、object、property、script API 或 asset kind 必须重新生成 census、补 corpus 并重新接受兼容决策。

## 不可变原则

- interactive、data binding、layout、event、audio、semantics、resource replacement、Luau 与 WGSL 不能用像素 baking 替代。
- 未知或不支持的 object/property/script/asset 在 strict 模式失败；仅 tuple 逐 key接受的 runtime-null object 可按固定 oracle 语义完整消费并独立报告，不能把该例外推广成 unknown-field/no-op 宽松行为。
- HYA 和公共 runtime 不暴露 Rive type/property id；`.riv`、官方 parser/renderer、Luau VM 与 Rive source class 不进入浏览器播放闭包。
- 任何没有 license provenance、不可变 source identity、source bytes SHA-256 和 oracle trace 的 corpus 输入都不是正式证据。source identity 可以是 Rive Cloud file revision，也可以是官方 `rive-app` 仓库的 commit + path；后者只临时下载并验 hash，不把 `.riv` 放入 HaiYue 仓库。

## G02/G10 follow-up execution boundary

- `convertRivBytesToHya` 是 raw `.riv` 的 build-time production orchestration：先执行 G02 strict import，再调用带 adapter/evaluator revision SHA-256 的 capability evaluator，最后让 G10 重新校验 Neutral IR hash、tuple、100% object/property coverage、G03–G09 sidecar parser 与 HYA binary round-trip。runner 不提供“空文档即支持”的默认 evaluator。
- `scripts/hya-corpus/rive-run-differential-trace.mjs` 只接受 revision-pinned native `@rive-app/webgl2@2.40.0`/WebGL2 与 `haiyue-exact-hya`/WebGPU capture adapter。11 个 channel 的 comparison 由 `rive-oracle-channel-contract.mjs` 从原始 capture 和 RGBA bytes 重算，capture adapter 不能直接提交通过结论。
- G01 revision 2 已确认 `565` 是旧生成器漏记的既有 property，并接受 `526` 为固定 oracle 的 runtime-null object；revision 3 进一步按 ADR 0089 分离 source/binary/behavioral evidence，禁止用 `.riv` 素材伪报 runtime-only property、asset base 或脚本源码注册项。G02 已重新生成 registry、实现 runtime-null 逐 key路径并完成 8/8 官方输入 strict admission。
