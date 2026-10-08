# Share Content

`@haiyue/extensions/share-content` 的最小示例：Engine GPU GUI 绘制固定数独棋盘，
在 after-update 截图，合成中英文、横竖版战绩卡，并生成/解析同题挑战 URL。
这里的数独仅用于视觉演示，不包含生成器或真正的挑战加载逻辑。

运行 `npm run build:target -- example:share-content`，通过示例服务器访问 index.html。
`?verify=1` 检查四种语言/版式输出、PNG 解码、像素非空、挑战往返和 GPU validation。
截图和卡片提前准备，点击时仅调用系统分享。示例自己的 Web adapter 用 navigator.share；
实际游戏可以把相同 PreparedShareContent 直接交给平台包 shareContent。

语言/版式切换取消旧准备；pagehide 取消任务、释放图片 URL/Bitmap 并销毁引擎。
Canvas2D 排版使用系统字体，精确字形因设备而异；不把截图哈希当作跨机器像素基线。
Native 工厂和真机分享需在对应宿主另行验收。
