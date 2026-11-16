# G03 视觉小说多素材舞台

`createHyaStage` 绑定 Scene 的帧更新和 AssetManager。宿主声明设计尺寸、按素材与变体 ID 解析 HYA，以及素材的 `hold`、`once` 或 `loop` 播放方式。带时长的模式以秒为单位。区域生产者按清屏、槽位、对话 GUI 的顺序组装。GUI 使用自己的显式区域和层序。

在现有 `connectNarrativeActions` 注册 `visualNovel.stage`，处理器由 `stageActionHandler(runtime, stage, compiled.definition.cues, getReducedMotion)` 创建。已编译的演出组依序执行，组内的显示、隐藏、状态、过渡和等待同时生效。通过 `stage.waiting` 查询当前是否还在准备资源，以及仍在等待的时间或事件。

- `states` 按状态 ID 声明静默时间和数据。素材的 `parameters` 可把稳定参数名映射到原 HYA 实例和属性路径。其他参数使用已有可写绑定。
- `transitions` 声明原 HYA 时间范围及可选结束状态。减少动态效果或调用 `skipDecorations()` 可直接进入装饰性过渡的结束姿态。显式时长等待和命名事件继续结算，同槽等待真实事件的过渡会正常播放。
- `stage.snapshot` 记录稳定槽位、时间和状态。用 `restore` 准备对应场景，确保首帧就绪后在帧边界切换。等待快照稳定后再提交存档和剧情进度。
- `preload` 接收宿主选出的临近分支槽位，只持有受并发和字节预算约束的源资源租约。实际播放各自拥有 Player。Scene Flow 切换或场景销毁时释放这些租约和舞台。

从 Engine 根目录执行原生对照。需保留 G01 的隔离安装目录和已校验的公开 tarball。

```sh
node scripts/fixtures/visual-novel-stage/run.mjs g03-native-720p 1280x720 3
node --test extensions/test/visual-novel-stage.test.mjs
```

浏览器夹具包含四个 HYA 槽和独立 GUI。它与同内容的手工 HYA 参考做整帧 RGBA 对照，测量首帧、连续 12 次恢复、帧间隔、CPU 更新与记录提交、同一命令缓冲区内的 GPU 时间戳、队列等待和 GPU 区域附件。三轮使用独立浏览器和设备。留存区域色彩、工作色彩、退役重叠和深度分别记录。0.2.4 整体生产发布资格由 G07 汇总。
