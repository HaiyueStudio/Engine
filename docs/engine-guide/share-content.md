# 战绩卡、截图和挑战链接

[运行示例](../../examples/share-content/index.html) · [API](../api/share-content.md)

## 准备战绩卡

```ts
import { prepareShareContent } from '@haiyue/extensions/share-content';

// i18n 已加载游戏语言包；图中和分享正文使用同一组消息 key。
const prepared = await prepareShareContent({
  title: { key: 'share.title' },
  text: { key: 'share.body', params: { time: '06:32' } },
  card: {
    title: { key: 'share.title' },
    badge: 'DAILY CHALLENGE',
    stats: [
      { label: { key: 'share.time' }, value: '06:32' },
      { label: { key: 'share.hints' }, value: '0' },
    ],
    footer: { key: 'share.challenge' },
  },
  challenge: {
    baseUrl: 'https://your-game.example/play',
    data: { gameId: 'sudoku', rulesVersion: 'generator-v3', mode: 'expert', seed: '104729' },
  },
}, { i18n, signal: sceneLifetime.signal });
```

结果包含普通文字、URL、PNG 字节。没有自动上传；`your-game.example` 需替换成游戏可访问的真实入口。
横版默认 1200 × 630；竖版可传 width:900、height:1200。支持最多四项统计、配色与字体设置。
文字放不下时缩小/换行，仍放不下会报错，避免成绩被省略。不要把整个结算详情塞进一张卡。
浏览器加载 Web 字体后再准备卡片，例如先 await document.fonts.ready；Native 同样需要宿主预先加载字体。
Intl.Segmenter 可用时按字素换行，否则按 Unicode 码点；字体覆盖与复杂文字排版取决于宿主 Canvas。

## 捕获当前帧

```ts
import { captureShareImage } from '@haiyue/extensions/share-content';

// Web：在引擎提交 GPU 命令后、浏览器清理当前帧前启动编码。
engine.once('after-update', () => {
  void captureShareImage(engine.canvas!, { signal: sceneLifetime.signal })
    .then(image => { /* 缓存图片供分享，或解码后作为战绩卡插图 */ })
    .catch(showError);
});
```

不要在 after-update 内先 await 网络或下一帧再截图。截图会包含该画布上的 HUD；
需要无 HUD 图片时由游戏渲染到已有离屏目标，不要临时隐藏真实 UI 影响玩家。
Native WebGPU 必须在提交后、presentSurface 释放当前纹理前调用，接线由 Native 宿主负责；
本模块不改变帧呈现时序。截图借用画布，不能传到战绩卡 createCanvas 工厂中复用。

浏览器可以把 image.bytes 包装为 Blob，再用 createImageBitmap 解码，传给
card.image 的 source/width/height。使用完调用 bitmap.close()。示例演示了这一流程和资源清理。
Native 需要提供其支持的已解码图片对象，以及独占的 Canvas2D 工厂；模块不引入 NativeScript。
注入示意：`renderShareCard(card, { i18n, createCanvas: createNativeCardSurface })`，
createNativeCardSurface 是宿主自定义函数，需满足 ShareCardSurface 的实际绘图/编码契约。
NativeScript 9.0.3 的 iOS V8 没有 Intl；使用 i18n 时由宿主补齐实际用到的 Intl API，
并确保 AbortSignal 提供 reason/throwIfAborted。普通文本卡片无需 Intl；缺少 Segmenter 时按码点换行。
内嵌 Canvas 建议填满固定尺寸的容器，避免 Android CanvasFit 把绘图缓冲尺寸反馈到布局测量。

## 调用系统分享

```ts
// 游戏宿主入口；不是 Engine 的依赖。
import { shareContent } from '@haiyue/native/share';

// prepared 在用户按下分享按钮之前就已生成。
shareButton.on('tap', () => {
  void shareContent(prepared).then(showShareStatus).catch(showError);
});
```

Web 也可以使用平台包的 share/web 子入口；普通 Web 构建不要导入 Native 根入口。
备选下载由游戏显式提供：为 bytes 建 Blob/Object URL，下载后或替换时撤销 URL。
平台返回完成只表示系统分享操作结束，不能用来证明社交平台已发布或发放奖励。

## 接收挑战

```ts
import { parseChallengeLink } from '@haiyue/extensions/share-content';

const challenge = parseChallengeLink(incomingUrl, {
  gameId: 'sudoku', rulesVersion: 'generator-v3', allowedOrigins: ['https://your-game.example'],
});
if (challenge) {
  // 游戏额外校验支持的 mode/seed，再让玩家确认开始同题挑战。
}
```

链接保存的是生成参数，不是可信战绩。它没有服务器签名、玩家身份或奖励凭证。
相同 seed 必须搭配相同规则和生成器版本才能复现；不能跨算法版本声称同一道题。
该扩展不监听深链、不注册 URL scheme、不切换游戏场景，也不自动导航。
