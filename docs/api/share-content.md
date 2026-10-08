# 分享内容 API

入口 `@haiyue/extensions/share-content`，可选稳定子入口，不聚合到根入口。
[接入指南](../engine-guide/share-content.md) · [示例](../../examples/share-content/README.md)

| API | 行为 |
| --- | --- |
| `captureShareImage(source, options?)` | 返回 `Promise<ShareImage>`，编码调用发生在第一次 await 前；借用源画布，不修改它 |
| `renderShareCard(card, options?)` | 返回 PNG/JPEG；拥有临时 Canvas2D，结束后重置尺寸 |
| `prepareShareContent(request, options?)` | 生成可直接交给平台层的 title、text、可选 url 和 image |
| `createChallengeLink(baseUrl, data)` | 在 HTTP(S) URL 的 `hyChallenge` 参数中编码 schema v1；保留原查询参数和 hash |
| `parseChallengeLink(link, policy)` | 无挑战参数返回 null；否则校验并返回冻结的 ChallengeData |

`ShareText` 为文字字符串，或 `{key, params?}`。后者要求 options.i18n，使用既有 i18n 的回退/缺词规则。
`ShareImage` 包含 bytes、mimeType、filename、width、height；bytes 是调用方拥有的可变 Uint8Array。
结果外壳冻结，像素字节未深冻结。模块不创建持久 Object URL。

`ShareCard` 包含 title，以及可选 subtitle、badge、footer、stats（最多四组 label/value）、
image（已解码 source、width、height、cover/contain）、fontFamily、colors。
colors 为 background/panel/text/muted/accent 的 `#RRGGBB`。文字单项最多 4096 字符。
默认 1200 × 630；支持横竖版，最小 420 × 320，长宽比不超过 2.5:1。

`ShareCardOptions` 扩展 `ShareImageOptions`：i18n、createCanvas。
`ShareImageOptions` 包含 mimeType（默认 image/png，可选 image/jpeg）、quality（0..1，默认 .9）、
filename（默认 result.png/result.jpg，扩展名匹配且不能包含路径分隔符）及 signal。
自定义 createCanvas 必须返回全新独占画布，调用方不要返回正在显示的游戏画布。
借用 image.source 必须保持有效直到操作完成；模块不负责解码/加载/释放它。

`ChallengeData` 为 gameId、rulesVersion、mode、seed 四个字符串。
前三项各 1..64 字符，seed 1..256 字符，无控制字符。只接受这些字段。
`ChallengeLinkPolicy` 必须指定 gameId、rulesVersion 和 allowedOrigins。
链接最多 8192 字符，challenge 参数最多 2048 字符；拒绝重复参数、未知版本、外来来源、
不同游戏/规则版本、凭据 URL 及非 HTTP(S) 协议。宿主需提供标准 URL/URLSearchParams 实现。

## 错误与取消

输入/协议错误抛 TypeError；尺寸、过长文字/链接或版式无法容纳抛 RangeError。
编码失败、格式回退、跨域污染、宿主缺少编码器/Canvas2D 抛 Error，底层安全异常可直接传播。
signal 取消以其 reason 拒绝。取消不会触发平台分享，也不会交付迟到编码结果；
浏览器底层的编码任务可能继续至完成。输出尺寸最多 4096 × 4096 且面积不超过 8 Mi 像素，
编码结果最多 10 MiB。这里只校验编码类型和文件签名，不提供通用不可信图片解码沙箱。

已准备好的图片应在用户点击之前缓存；点击中只调用平台分享，避免 Web 用户激活过期。
UI 连续修改需要宿主取消上次准备，并使用 generation 检查丢弃旧结果，示例已实现。
