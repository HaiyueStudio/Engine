# 制作视觉小说

《雾港》是一份独立的浏览器模板。玩家可以用中英文游玩三章，走向不同的结局，从手动存档或最近一次自动存档继续，并在通关后回看已解锁的演出。

## 运行

把 G06 交付的 `last-lantern-kit.tar.gz` 解压到空目录。在 Node.js 22 或更新版本下运行以下命令，然后用支持 WebGPU 的浏览器打开终端输出的地址。首次安装需要访问 npm 下载构建工具与第三方依赖，海月包已放在 `vendor/`。

```sh
npm ci
npm run build
npm start
```

点「新故事」。在第一章选择留下或离开，推进对白直到结局。对话期间可保存到两个手动位置，浏览器重开后可选「继续游戏」。侧栏提供字号、即时显示、高对比度、历史配音和结局回看。回看期间主线进度保留，点「返回故事」可恢复演出前的阅读位置。浏览器按来源隔离存档，重开时请保留原地址和端口。

G06 模板经由公开包入口运行。随包的 Engine 与 Extensions 是本地验收 tarball，正式发布集成由 G07 负责。

## 改一幕

- 从 `project/story.json` 进入。台本按三个章节分文件，显示文字与语音映射在 `zh-Hans.json`、`en.json`。优先修改台本和本地化数据。阅读界面从编译产物装配。
- 修改 `rain-night` 里守灯人的位置，调一次即可影响使用同一预设的章节。背景、两个人物和天气各有独立的 HYA 素材与顺序。
- 将 `assets/signal.hya.json` 复制成新的特效，先修改颜色并保留完成事件，在 `story.json` 注册素材并改防波堤的 cue。要从头生成原示例的 HYA，可以运行 `node tools/create-art.mjs`。
- 要增加条件结局，可给选项增加一个改变 `trust` 的动作，在第三章前增加对应条件分支，加入新结束节点和两种语言的文本，再注册一条预览路线。

```sh
node tools/author.mjs check project/story.json --strict
node tools/author.mjs preview project/story.json --route lantern
npm run build
```

素材来源、制作方法和许可见项目目录下的 `LICENSE-ASSETS.md`。示例配音由语音合成生成，历史重听与背景音乐共用引擎混音器。
