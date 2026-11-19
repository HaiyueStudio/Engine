# 视觉小说

`@haiyue/extensions/visual-novel` 将剧情、HYA 舞台、阅读 GUI、混音和存档装配为一个浏览器会话。作者台本经编译后再交给播放器。创作流程见[制作视觉小说](../engine-guide/visual-novel.md)，完整场景见[《雾港》示例](../../examples/visual-novel/index.html)。

## 入口

`validateVisualNovelDefinition(source)` 检查编译产物的基本结构、剧情定义、项目内资产路径、预设和回看格式。成功时返回 `VisualNovelDefinition`。作者工具还检查引用和源文件位置。

`createVisualNovel(options)` 接收已初始化的 Engine、I18n、本地存储、混音器、编译后的项目和资产目录 URL。请在 I18n 注册项目语言包。可为会话指定背景音乐资产 ID、存档槽及错误回调。由应用启动引擎帧循环，并在浏览器用户操作时解锁混音器。

项目使用变体、具名状态、过渡区间或自有 HYA 资源端口时，通过 `resolveHya` 提供对应素材及舞台配置。默认加载项目内的 HYA JSON。

```ts
import { createVisualNovel } from '@haiyue/extensions/visual-novel';

const session = createVisualNovel({
  engine, i18n, mixer, story,
  storage: localStorage,
  assetRoot: new URL('./project/', location.href),
  music: 'music',
});
engine.run();

// Call from a user action to unlock audio.
await mixer.unlock();
await session.start(crypto.randomUUID());
```

## 会话

| 操作 | 行为 |
| --- | --- |
| `view` 和 `subscribe` | 读取当前对白、选项、历史、舞台槽、混音及区域观察值；订阅返回取消订阅函数。 |
| `start`、`advance`、`choose` | 使用新的游玩 ID 开始；首次确认会补全正在逐字显示的对白；使用稳定选项 ID 作选择。 |
| `setPreferences`、`replayVoice` | 调整阅读偏好；使用历史条目键重听，音乐的临时衰减在结束或取消时恢复。 |
| `save`、`load`、`continueLatest` | 在已提交的对白或选择处保存。存档恢复后再切换可见舞台；可选缩略图失败时仍保存文字元数据。 |
| `listReplays`、`startReplay`、`endReplay` | 列出已解锁演出，进入隔离回看，或返回原剧情。 |
| `dispose` | 中止会话，释放舞台与音频租约。传入的 Engine、I18n、混音器仍由应用管理。 |

公开类型为 `VisualNovelDefinition`、`VisualNovelOptions`、`VisualNovelSession`、`VisualNovelSnapshot` 和 `VisualNovelView`。无效编译输入报告 `E_GAMEPLAY_INVALID_INPUT`，存档错误沿用 [GameSaveError](save.md)，被更新事务替换的恢复沿用 Scene Flow 错误。
