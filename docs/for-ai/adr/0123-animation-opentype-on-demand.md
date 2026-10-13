# ADR 0123：动画文本 OpenType 按需准备

- 状态：Accepted
- 日期：2026-10-11
- 部分替代：[ADR 0106](0106-release-0.2.0-capability-budgets.md) 中动画消费端始终承担 OpenType 静态下载成本的决策。
- 延续：[ADR 0122](0122-package-capability-structure-review.md) 的能力结构、公开覆盖和字节预算。

## 决策

1. Animation2D 与 HYA 状态机复用同一私有字体准备路径。导入公开入口、无文本动画、仅系统字体文本均不请求 OpenType。实际物化的 `text2d` 引用 `fontResource`，且字体字节和 `FontFace.load()` 成功后，才通过动态 import 准备解析器。包括 text document 与 style run 引用的字体；尚未物化的延后节点保留原有准备时机。
2. 解析器加载属于现有字体资源的 `pendingResourceCount`，不另增一项计数。下载和解析完成、字体注册、所有等待文本的 atlas 失效处理后，该项才结束。这个计数不承诺 GPU 上传或 ImageBitmap 转换已经结束；渲染器继续按原纹理版本更新。准备期间沿用已有占位字体绘制。
3. 动态块下载或模块初始化失败进入 `failedResourceCount`，释放资产句柄，不把失败伪装成准备成功。同一 runtime 的失败资源不自动循环重试；重建 runtime 可再次发起准备，实际模块重试仍受浏览器模块缓存规则限制。已由 FontFace 接受、但 OpenType 不支持的字体容器保留现有 Canvas 回退，不计为新增失败。
4. 并发请求共用解析器 promise，同一 ArrayBuffer 共用弱引用解析结果（含不支持容器的结果）。后续物化的文本直接复用准备结果。销毁期间无法取消浏览器模块下载，但完成后不得注册 FontFace、重绘已销毁文本或保留资产句柄。
5. 不新增公开子路径、开关、注册步骤或依赖版本。消费者以 ES module 分块输出并部署完整产物目录，才能获得下载延迟；强制 `inlineDynamicImports` 的单文件/IIFE 输出仍包含解析器。仓库原有 IIFE examples 保持兼容，不宣称它们获得网络节省。
6. 原有整包和完整功能消费端字节上限不变，继续测量原来的内联消费口径。对两个动画入口另增加 ES module 分块消费验证：静态依赖的传递闭包作为初始下载，其他可达块作为延后下载，各文件独立 gzip 后求和。要求 OpenType 仅位于延后块，所有静态/动态引用均有实际产物，同时约束初始下载和全部块总量。

## 验证

工作区测试覆盖未使用、共享、失败、销毁、字体加载失败、不支持容器回退及后来物化的文本。真实浏览器验证 HTTP 请求和普通、样式段、selector 文本像素；独立 tarball 安装验证分块解析、类型与原完整功能预算。配置、测量与结果见 [API 评审](../../../review/api/animation-opentype-loading-review.md)。不改变 G09 性能合同或 5% 回归预算。
