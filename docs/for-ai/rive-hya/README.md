# Rive → HYA full-fidelity contracts

本目录冻结 M07 的 Rive 兼容分母。它描述的是 build-time `.riv` 导入与来源无关 HYA 能力，不是把 Rive runtime 加入 HaiYue 页面播放闭包。

## 阅读顺序

1. [ADR 0087](../adr/0087-rive-hya-source-neutral-full-fidelity.md)：Accepted 架构与 no-go。
2. [compatibility-tuple.json](./compatibility-tuple.json)：唯一受支持的官方格式/source/oracle 修订。
3. [feature-gap-matrix.md](./feature-gap-matrix.md)：当前 HYA 与完整 Rive family 的能力差距。
4. [runtime-census.json](./runtime-census.json)：从冻结 source 生成的逐 object/property/script/asset census。
5. [diagnostic-catalog.md](./diagnostic-catalog.md)：strict 失败协议。
6. [threat-model.md](./threat-model.md) 与 [license-matrix.md](./license-matrix.md)：不可信执行与内容权利边界。
7. [dependency-boundary.md](./dependency-boundary.md) 与 [browser-runtime-deny-list.json](./browser-runtime-deny-list.json)：包边界和浏览器闭包。
8. [corpus-oracle-manifest.json](./corpus-oracle-manifest.json) 与 [evidence-plan.md](./evidence-plan.md)：产品 case、corpus、oracle 和设备证据。
9. [g01-acceptance.md](./g01-acceptance.md)：G01 的逐项审查结论。

`tools/` 只保存 census 的可复现生成器；生成结果本身受兼容 tuple 和 source digest 约束。

## 冻结结论

- `.riv` denominator：fingerprint `RIVE`、format `7.3`。
- 官方 source：`rive-app/rive-runtime@526625850eaf34fc1263d181808ffca10cae6ac1`，其 `.rive_head` 为 `ee809ba7f032271dd7102f17afe3baf9d192435b`。
- differential oracle：`@rive-app/webgl2@2.40.0` 的固定 npm tarball/WASM。
- census：288 个可实例化 runtime object、611 个 runtime property key、48 个 Luau 注册模块、349 个注册 symbol、14 个 asset type definition（其中 9 个可序列化）；所有分类计数均为 0。
- `full-fidelity` 只对该 tuple 成立。未来 minor、object、property、script API 或 asset kind 必须重新生成 census、补 corpus 并重新接受兼容决策。

## 不可变原则

- interactive、data binding、layout、event、audio、semantics、resource replacement、Luau 与 WGSL 不能用像素 baking 替代。
- 未知或不支持的 object/property/script/asset 在 strict 模式失败；不采用官方 runtime 的 unknown-field/no-op 宽松行为。
- HYA 和公共 runtime 不暴露 Rive type/property id；`.riv`、官方 parser/renderer、Luau VM 与 Rive source class 不进入浏览器播放闭包。
- 任何没有 license provenance、Rive file revision、source bytes SHA-256 和 oracle trace 的 corpus 文件都不是正式证据。
