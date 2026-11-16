# G05 存档、续读和回看

槽位使用原有 `GameSaveService`。逐槽校验使坏档只影响对应槽位。读取旧档时按应用登记的迁移函数转换，原记录保持可供诊断。手动保存和自动保存只接受已提交的对白或选择边界。缩略图在宿主请求时采集，失败仍可保存。

`VisualNovelSaveSession` 通过 `createSceneSaveHost` 驱动 G03 舞台和 G04 阅读器。新场景先在离屏目标准备，提交时把画面、读取状态和宿主音轨一同切换。宿主 `music.prepare` 用已保存的素材和播放状态准备音轨，`active` 在场景切换时接管播放。原游戏动作继续由宿主按 `request.token` 去重。章节与 CG 回看只使用已完成路线记录的选项和动作结果。

```sh
node --test extensions/test/visual-novel-save.test.mjs
node scripts/fixtures/visual-novel-save/run.mjs fresh-native-run
```

浏览器夹具导航到新文档，通过实际 LocalStorage 重新建立应用和原生 GPU 场景。报告包含画质、音轨状态、失败回退和资源清理。
