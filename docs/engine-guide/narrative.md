# 分支剧情、对话 GUI 与状态机

[运行示例](../../examples/narrative/index.html) · [示例说明](../../examples/narrative/README.md) · [API](../api/narrative.md)

## 组织剧情

JSON 中用节点 ID 连接流程，textKey 与 artwork.assetKey 指向游戏语言包。
所有变量在 variables 中声明；effect 与选项效果可以 set/add，branch 根据变量跳转。
可隐藏或禁用选项，确保每个选择节点保留一条可走的路径。

```ts
import { NarrativeRuntime, NarrativeGui, connectNarrativeActions, validateNarrativeDefinition } from '@haiyue/extensions/narrative';
import { createI18nTextureLoader } from '@haiyue/extensions/i18n';

// engine、guiRoot、i18n 已由游戏初始化；storyJson 是读取的 JSON。
const story = new NarrativeRuntime(validateNarrativeDefinition(storyJson));
const lifetime = new AbortController();
const dialog = new NarrativeGui(story, {
  parent: guiRoot.root,
  i18n,
  continueKey: 'dialogue.continue',
  waitingKey: 'dialogue.waiting',
  imageLoader: createI18nTextureLoader(engine.assetManager!, new URL('./', location.href).href),
  signal: lifetime.signal,
});
story.start(crypto.randomUUID());
await dialog.ready;
if (dialog.imageError) console.warn(dialog.imageError);
```

GUI 字库必须包含台词和按钮的字符。可用 collectLocaleCharacters 从场景语言包收集，
在创建场景时配置 gui.font.chars。不要将所有章节、全部语言无条件塞入单个字体图集。
布局变化只重建剧情面板自己的文字与按钮；不执行逐帧剧情解释。

## 连接游戏状态机

动作节点如 `{ "type": "action", "name": "battle", "next": "after-battle" }` 会暂停剧情。
宿主注册 battle 处理器，切换游戏状态，收到结果后 resolve 已声明的剧情变量。

```ts
const actions = connectNarrativeActions(story, {
  battle: async (request, signal) => {
    // 此函数由游戏实现。须支持取消，并用 token 恢复/去重同一场战斗。
    const won = await game.enterBattle({ token: request.token, signal });
    return { won };
  },
}, { signal: lifetime.signal });
```

这里的 game.enterBattle 是宿主接口示意，不是引擎新增方法。
后续 branch 根据 won 判断走向；动画状态机仅负责角色动作和表情。
未知动作或执行失败不会自动跳过：检查 actions.error，修复原因后 actions.retry()。
订阅 change/end 可更新宿主 HUD、退出剧情模式，但推进剧情应安排在事件分发结束之后。

## 保存和恢复

```ts
const save = JSON.stringify(story.save());
// 交给游戏自己的存储系统；引擎不选择 localStorage 或原生文件路径。
story.restore(JSON.parse(save));

// 场景退出先断开 GUI、handler 和加载；共享 i18n 可继续用于其他场景。
lifetime.abort();
story.dispose();
```

存档包含剧情版本、节点、变量、选择历史与待处理动作。版本不兼容会明确拒绝，
迁移必须由游戏根据剧情改动完成。存档校验是结构校验，不是防作弊签名或历史回放证明。

普通变量效果随一次推进整体提交；保存后恢复不会重放这些节点。
外部发奖需宿主把 token、奖励变更、返回结果作为同一事务保存。
`示例使用 localStorage 中的一条记录同时保存模拟奖励和结果`，仅用于演示，不能代替服务端经济系统。
已经完成的 end 事件也会在恢复时再次通知，解锁成就同样需要宿主去重。

## 演出扩展

首版包含插图、对话、选项与结局，播放器与计时器由宿主接入 action。
视频、语音、现实时间等待、限时选项、可视化编辑器后续可以扩展，但不要在 JSON 中嵌入可执行脚本。
跨退出的等待需要存储截止时间与恢复语义；单独的 setTimeout 不能实现这点。
