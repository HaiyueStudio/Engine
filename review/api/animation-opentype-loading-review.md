# 动画文本OpenType：问题、方法、结论

合同见 [ADR 0123](../../docs/for-ai/adr/0123-animation-opentype-on-demand.md)，原证据绑定见[机器记录](animation-opentype-loading-checks.json)。

| 问题 | 方法 | 结论与边界 |
| --- | --- | --- |
| 无文字动画也在初始闭包下载OpenType | `/animation`、`/hya-state-machine`共用私有异步准备器，首次有效字体触发dynamic import，共享promise，按ArrayBuffer弱引用缓存 | 原独立tarball的初始gzip223,053→125,830B、230,623→133,401B；完整功能分块总量仍受原245,000/255,000B上限约束，不以初始减少冒充总下载减少 |
| 解析器故障与不支持字体容器容易混淆 | chunk/network失败按资源错误处理；FontFace已接受但轮廓解析不支持时维持Canvas shaping回退 | 并发加载与失败重试遵循不同资源身份，不静默吞掉chunk故障 |
| 字体准备晚返回可能恢复已销毁纹理 | 准备结束检查owner代次，FontFace/句柄由runtime持有，晚bitmap结果关闭 | 原浏览器三类atlas对照、非空像素与释放验证通过；声明不泄漏第三方开发类型 |

实际ESM初始量包含静态传递依赖，动态块独立压缩并计总量；examples的IIFE会内联动态导入，不能据此宣称按需网络节省。现行预算以[包策略](../../config/engine-package-budget.json)为准，所有旧上限及声明保持。

全仓重建/测试计数、沙箱symlink失败与重试、逐包尺寸和浏览器原文见[校验归档](../archive/engine-review-process-20261020.json)。字体准备通过不是G09性能资格，也不单独证明版本已发布。
