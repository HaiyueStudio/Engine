# Rive import diagnostic catalog

所有跨 Worker/进程诊断遵守 ADR 0008 的 `EngineError`/`SerializedEngineError`：`domain`、`code`、纯文本 `message`、`recoverable`、`recovery`、`path`、`context` 和可选 `cause`。domain 固定为 `animation-import`；strict/full-fidelity 不产生“成功但有语义 warning”的产物。

## Path 与 context

- object：`$.riv.objects[typeKey=152][index=37]`
- property：`$.riv.objects[typeKey=152][index=37].properties[key=901]`
- asset：`$.riv.assets[id=...].contents`
- script：`$.riv.scripts[id=...].symbols[name=...]`
- WGSL：`$.riv.shaders[id=...].bindings[group=...][binding=...]`

context 至少记录 `tupleId`、input SHA-256、format major/minor、object/property key（适用时）、profile、Goal/fixture owner 和 budget observed/limit（适用时）。不得把原始脚本、URL token、私有文件路径或完整 asset bytes 放入 message/log。

## 稳定 codes

| Code | 触发条件 | recovery |
| --- | --- | --- |
| `E_RIVE_INVALID_FINGERPRINT` | 前四字节不是 `RIVE` | `release-resource` |
| `E_RIVE_FORMAT_MAJOR_UNSUPPORTED` | major 不是 7 | `release-resource` |
| `E_RIVE_FORMAT_MINOR_UNSUPPORTED` | formal profile minor 不是 3 | `release-resource` |
| `E_RIVE_TRUNCATED` | header/ToC/object/property payload 截断 | `release-resource` |
| `E_RIVE_VARINT_OVERFLOW` | varuint/zigzag 超出 reader 范围 | `release-resource` |
| `E_RIVE_TOC_INVALID` | property field type table 冲突、重复或越界 | `release-resource` |
| `E_RIVE_LIMIT_EXCEEDED` | ADR 0087 任一 hard budget 超限 | `release-resource` |
| `E_RIVE_UNKNOWN_OBJECT` | type key 不在 frozen `CoreRegistry` census | `release-resource` |
| `E_RIVE_UNKNOWN_PROPERTY` | property key 不在 frozen property census | `release-resource` |
| `E_RIVE_UNSUPPORTED_OBJECT` | census 已知但当前 Goal 尚未提供完整 mapping | `release-resource` |
| `E_RIVE_UNSUPPORTED_PROPERTY` | census 已知 property 无无损 mapping | `release-resource` |
| `E_RIVE_REFERENCE_INVALID` | owner/index/id/type/ancestor reference 缺失或不合法 | `release-resource` |
| `E_RIVE_REFERENCE_CYCLE` | 非许可的 component/layout/data/resource cycle | `release-resource` |
| `E_RIVE_SEMANTIC_LOSS` | mapping 会丢 observable、改变 order/value/identity | `release-resource` |
| `E_RIVE_VISUAL_BAKE_INELIGIBLE` | 子图含 interaction/data/layout/event/audio/semantic/script/replacement observable | `release-resource` |
| `E_RIVE_BAKE_ERROR_EXCEEDED` | 自适应采样仍超过批准误差 | `release-resource` |
| `E_RIVE_ASSET_MISSING` | embedded/referenced/hosted asset 无法解析 | `retry` |
| `E_RIVE_ASSET_INTEGRITY` | bytes 与 manifest SHA-256/size/MIME 不符 | `release-resource` |
| `E_RIVE_ASSET_LICENSE` | provenance/allowed use/redistribution evidence 缺失 | `release-resource` |
| `E_RIVE_ASSET_URL_POLICY` | scheme/origin/redirect/CORS/credential 不在 allow-list | `release-resource` |
| `E_RIVE_ASSET_DECODE` | font/image/audio/compressed texture decode 失败 | `release-resource` |
| `E_RIVE_SCRIPT_DISABLED` | profile/host 未启用 isolated sandbox protocol | `release-resource` |
| `E_RIVE_SCRIPT_CAPABILITY` | 脚本请求 undeclared/forbidden host capability | `terminate-runtime` |
| `E_RIVE_SCRIPT_BUDGET` | instruction/time/heap/call/output/event budget 超限 | `terminate-runtime` |
| `E_RIVE_SCRIPT_PROTOCOL` | typed port、message、ABI version 或 result 非法 | `terminate-runtime` |
| `E_RIVE_SHADER_INVALID` | WGSL parse/type/validation/entry 失败 | `release-resource` |
| `E_RIVE_SHADER_BINDING` | binding/format/usage 超出 allow-list | `terminate-runtime` |
| `E_RIVE_SHADER_BUDGET` | source/resource/pipeline/GPU time budget 超限 | `terminate-runtime` |
| `E_RIVE_ORACLE_MISMATCH` | frozen trace 任一 channel 超 tolerance 或 order 不同 | `release-resource` |
| `E_RIVE_BROWSER_CLOSURE` | deny-list 在 package/bundle/source-map/network 命中 | `release-resource` |
| `E_RIVE_ABORTED` | owner 主动 abort、reimport、project close | `retry` |
| `E_RIVE_INTERNAL` | adapter invariant/不可分类内部失败 | `terminate-runtime` |

## Strict 规则

- unknown 与 unsupported 分开；不得把 unknown 归为可忽略 metadata。
- `E_RIVE_ABORTED` 只有 owner 已请求取消时可 recoverable；timeout/budget 使用对应稳定 code。
- official runtime 成功加载不覆盖 HaiYue 的 strict failure。
- normal/inspection 模式可以返回 inventory 加 errors，但不得返回可发布 HYA。formal `full-fidelity` 只有 `diagnostics=[]` 才成功。
- census 中 `hyaStatus=full` 的条目仍受 `E_RIVE_ORACLE_MISMATCH` 保护；声明可表达不等于无需验证。

