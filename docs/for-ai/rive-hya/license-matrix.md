# License and content-rights matrix

本文件是工程准入政策，不替代针对具体发行的法律意见。结论只覆盖 G01 的 build-time oracle/adapter 计划；任何新增 vendoring、binary redistribution 或 corpus asset 都必须带自己的 license evidence。

## Code and generated artifacts

| Material | Frozen source/revision | License decision | Distribution rule |
| --- | --- | --- | --- |
| Rive runtime source and generated headers | `rive-app/rive-runtime@526625850eaf34fc1263d181808ffca10cae6ac1` | MIT, acceptable | Preserve copyright/license in any vendored source/binary notices; generated keys retain upstream provenance |
| Official WebGL2 oracle | `@rive-app/webgl2@2.40.0`, fixed integrity/WASM hashes | MIT, acceptable | test/build-time oracle only; if redistributed, include MIT notice; forbidden in HYA browser player closure |
| HarfBuzz fork | `rive-app/harfbuzz@rive_13.1.1` | upstream MIT-style/Old MIT, acceptable with notices | only if a future source build vendors it; preserve all bundled notices |
| SheenBidi | `Tehreer/SheenBidi@v2.6` | Apache-2.0, acceptable | preserve LICENSE/NOTICE and attribution when redistributed |
| Yoga fork | `rive-app/yoga@rive_changes_v2_0_1_2_grid` | MIT, acceptable | preserve notice when redistributed |
| miniaudio fork | `rive-app/miniaudio@rive_changes_5` | public-domain or MIT-0 dual terms; acceptable | select/document MIT-0 path where a license identifier is required; preserve upstream notice |
| Luau fork | `luigi-rosso/luau@rive_0_733` | MIT, acceptable | build/sandbox implementation only; preserve notice; license does not make scripts trusted |
| libhydrogen fork | `luigi-rosso/libhydrogen@rive_0_2` | ISC, acceptable | preserve notice when redistributed |
| libpng + zlib | `libpng16`, `zlib@v1.3.1` | libpng-2.0/zlib, acceptable | preserve notices; mutable `libpng16` branch must be replaced by an exact commit before source vendoring |
| libjpeg fork | `rive-app/libjpeg@v9f` | IJG/BSD-like terms, acceptable after exact notice bundle capture | preserve README/LICENSE notices; no redistribution from tag alone without captured license files |
| libwebp | `webmproject/libwebp@v1.4.0` | BSD-3-Clause, acceptable | preserve notice |
| Naga or other shader build tools | not part of frozen npm oracle payload identity | build-tool license reviewed at adoption | never infer a shipped dependency from source comments; pin exact tool/package and notice before vendoring |

The [official Rive runtime documentation](https://rive.app/docs/runtimes/getting-started) states its runtimes are open source under MIT. This covers runtime code, not the artwork/audio/fonts contained in a `.riv` file.

## Content and evidence

| Content | Default rights | Formal corpus / output rule |
| --- | --- | --- |
| self-owned `.riv` | project owner copyright | record owner approval, Rive file revision id, bytes SHA-256, allowed internal/public uses |
| official `rive-app` repository `.riv` | exact official repository commit/path and repository license evidence | eligible as a formal remote input under the accepted G11 policy；record immutable human/download URLs, byte length, SHA-256, MIT attribution and transitive assets；fetch to ephemeral storage and do not commit source bytes |
| Rive Marketplace/Community file | [Marketplace documentation](https://rive.app/docs/community/marketplace-overview) and [Terms §D.6](https://rive.app/docs/legal/terms-of-service) identify Community files as CC BY 4.0 | record creator, title, immutable source URL/revision, CC BY 4.0, attribution text and modification/conversion notice; validate embedded third-party assets separately |
| private/team Rive file | no rights granted to HaiYue merely by access | require owner authorization; never publish fixture/evidence bytes without explicit redistribution right |
| font | font EULA/OFL/Apache/etc. file-specific | embedding, subsetting, conversion and redistribution rights all recorded; OFL Reserved Font Name and notice obligations preserved; otherwise internal-only |
| image/texture | copyright/trademark/privacy file-specific | record source, author, license, modifications, redistribution and product-use rights; no default from `.riv` container |
| audio | composition, recording and performer rights may differ | record each right and territory/use; oracle playback right does not imply redistribution; otherwise use self-owned/CC0 test audio |
| hosted asset/CDN URL | access token/URL is not a license | cache only when allowed; record immutable bytes hash and terms; no credential in manifest/log; public HYA output must not depend on expiring private URL |
| library/component dependency | source library/version rights may differ from host file | resolve transitive dependency graph and license every component/asset; host export permission is not proof of redistribution rights |
| converted HYA | derivative of source content | carry provenance/attribution sidecar; conversion does not erase source license; output distribution must fit original allowed uses |
| screenshots, pixel diffs, audio traces | derived evidence may still reproduce protected content | store minimum necessary, access-control internal evidence when public redistribution is absent; public reports use licensed/self-owned redacted evidence |
| hashes, counts, timings, diagnostics | normally non-expressive metadata | may be published if they contain no secret URL/name/payload; redact private identifiers |

## Manifest requirements

Every formal corpus entry must provide:

- source owner/creator, immutable source/revision and SHA-256；
- SPDX id or exact custom terms URL/snapshot；
- permissions for import, modification/derivative, automated oracle execution, CI storage, screenshot/audio evidence and HYA redistribution；
- attribution/notices and location where they will ship；
- transitive font/image/audio/library/hosted asset entries；
- visibility: `public-redistributable`、`internal-evidence-only` 或 `local-never-upload`。

Missing or conflicting evidence yields `E_RIVE_ASSET_LICENSE`. It cannot be downgraded to a warning in formal mode。

## Accepted policy

- G01 may use the fixed official package/source as build-time research/oracle under MIT。
- Exact official `rive-app` repository fixtures may be formal evidence inputs when commit/path/URLs/hash/license attribution are pinned；the repository stores only metadata and run artifacts, not `.riv` source bytes。
- M07 does not vendor or ship official Rive code at G01；future vendoring requires exact dependency commits and aggregated notices。
- Marketplace material is eligible only with CC BY 4.0 attribution and per-asset transitive review；self-owned corpus is preferred for product and adversarial evidence。
- No corpus/output license is inferred from successful download, Editor access, runtime export entitlement or a hosted URL。
