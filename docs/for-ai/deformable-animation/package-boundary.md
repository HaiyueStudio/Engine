# 包与运行时边界

## Ownership

| Owner | 允许内容 | 禁止内容 |
| --- | --- | --- |
| `@haiyue/animation-spec/deformable2d` | source-neutral types、validator、HYDM codec | DOM、WebGPU、Engine、Cubism 类型 |
| `@haiyue/animation-spec/live2d` | capture data types、Motion3 build-time sampler、capture-to-HYA converter | 浏览器播放器、Core 二进制、运行时 source parser |
| `@haiyue/animation-spec/conversion` | adapter/session、adaptive sampler、hash/provenance、transaction port | 来源 SDK、DOM、Node filesystem、runtime player |
| `@haiyue/animation-spec/live2d/clip-baked` | evaluator 注入 contract 与 Cubism clip-baked pipeline | Cubism Core、Framework、浏览器 player、来源二进制 |
| `animation-spec/live2d/tools` | 调用者提供 Core/模型的本地 capture 工具 | npm package、公开站点、自动许可接受、WPK 解包 |
| `@haiyue/extensions/deformable-animation` | HYA drawable sampler、owner、通用 Animation2D visual | `.model3.json`、`.moc3`、Motion3、Cubism id/SDK 分支 |
| Editor import plugin | recipe、progress/abort、diagnostics、派生 HYA identity | 默认首屏 Core、源码跨仓 import、preview source runtime |

`@haiyue/engine` root 和 `@haiyue/extensions` root 不增加 Live2D API。播放能力只从 focused subpath lazy load；格式包不依赖 Engine、DOM、WebGPU 或 Editor。

G05/G06 的 framework 与 evaluator adapter 由 G09 以 focused subpath 转正。`conversion` 保持来源无关，`live2d/clip-baked` 只公开 build-time evaluator 注入边界；二者都不能让 Core/Framework 或来源播放器进入 npm/runtime closure。

## Integrity and provenance ownership

- HYDM header/version/range 由 `deformable2d` parser 验证。
- HYA binary resource 的 `integrity` 字段拥有 sidecar/texture 内容完整性；converter/package writer 负责计算并记录 SHA-256，runtime asset manager 负责按资源合同校验。
- Conversion report 记录 source/Core/adapter version、recipe、输入 hash、采样配置、diagnostic、输出 hash；HYDM 不嵌入 `.moc3` 或 Core state。

## Runtime closure acceptance

[`runtime-deny-list.json`](./runtime-deny-list.json) 同时应用于：

- `@haiyue/animation-spec` 与 `@haiyue/extensions` npm tarball；
- Editor/示例 bundle 与 source map；
- 转换后的 HYA/package；
- 浏览器 network request URL/content type；
- CI artifact 和 cache manifest。

本地 capture 页面加载 caller-configured Core URL 不属于 playback closure；其产物必须在删除 Core、Framework 和 source model 后仍可由 HYA runtime 播放。
