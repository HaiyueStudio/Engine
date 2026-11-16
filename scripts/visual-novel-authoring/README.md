# 视觉小说台本与路线预览

在 Engine 仓库根目录安装工作区依赖并构建 Animation Spec（`npm run build -w ./animation-spec`）。下列命令使用 Node.js 22 或更新版本。示例有三章、两种语言、两条合流后分别到达不同结局的路线，以及一个在两章复用的双槽 HYA 预设。

```sh
node scripts/visual-novel-authoring/cli.mjs check scripts/visual-novel-authoring/example/story.json --strict
node scripts/visual-novel-authoring/cli.mjs compile scripts/visual-novel-authoring/example/story.json --out harbor.compiled.json
node scripts/visual-novel-authoring/cli.mjs preview scripts/visual-novel-authoring/example/story.json --route stay --line first-view --reload
```

## 台本

`story.json` 声明故事 ID、存档版本、起点、变量、章节文件、语言包、资产、演出预设和路线。所有路径以 `story.json` 所在目录为根。每个章节文件提供稳定的 `id` 和以局部节点 ID 为键的 `nodes`。同章跳转写 `next: "view"`，跨章写 `next: "pier/shared"`。入口和路线步骤使用完整的 `chapter/node`。文件名可改，存档使用章／节点 ID。对白、选择、结局和带文字的动作都有稳定 `lineId`。改译文、换配音和调整演出时保留 ID。修改会改变旧存档含义的剧情时更新故事 `version`。

对白、选择、条件分支、变量修改、宿主动作和结局使用已有 Narrative 节点字段。文本、说话人、选项和图片说明引用现有 LocalePack 的 `messages` 键。行可增加 `"voices": { "zh-Hans": "greeting" }`，值是声明为 `audio` 的资产 ID。写出 `voices` 表示需要配音检查，空表会提示所有语言缺配音。省略该字段可保留无配音行。宿主动作的名称须列在项目的 `actions`，预览中的结果由路线提供。

## 演出

用 `type: "stage"` 的节点插入演出和 `next`。其 `cues` 是按顺序执行的组数组，组内指令并行。预设由独立 HYA 槽组成，设置 `id`、`assetId`、`bounds`（x、y、宽、高）和 `order`，可选 `variantId`、`fit`、`time` 及标量 `data`。项目登记的 HYA 资产使用原 HYA 组合格式。

- `show` 使用 `presetId`，可选 `slotId` 只显示该槽。已有同名槽由预设替换。
- `hide` 使用 `slotId`，`state` 同时指定 `stateId`。
- `transition` 使用 `slotId`、`transitionId` 和 `seconds`，可设 `decorative: true`。
- `wait` 使用 `kind: "duration"` 和 `seconds`，或 `kind: "event"`、`slotId` 和 `event`。需要对同一槽连续做多个改变时分成不同组。

编译输出中的 `definition.narrative` 可直接交给 `NarrativeRuntime`。演出节点被转换为 `visualNovel.stage` 动作，`definition.cues` 按该动作节点的完整 ID 索引已解析的组。行、语言包及具名路线位于 `lines`、`locales`、`routes`。可选 `definition.replays` 以稳定回看 ID 定义起止行。

## 诊断与重载

`check` 报告文件、行、列和错误码。缺译文、已声明行的缺配音和结构不可达结局默认是警告，加 `--strict` 时返回失败。自动环检查报告无法退出自动节点子图的环。条件控制的路线可用不同变量预设运行。资产检查覆盖声明、类型、路径、文件和 HYA 组合格式，图片／音频的实际解码在播放宿主验证。

路线可指定语言和初始变量，并按发生顺序列出选择（`choiceId`）、演出完成（`stage: true`）或宿主动作模拟结果（`result`）。未指定确认的动作或选项会暂停并显示原因。预览输出当前行、变量、选项条件、已提交槽位和待确认的资源／等待阶段。它从独立剧情会话重放到目标行，模拟演出和宿主动作。

保持 `--reload` 窗口打开，在编辑器保存对白或舞台指令后按 Enter。成功时重新定位到同一稳定行，失败时输出诊断并保留最近一次可用预览。输入 `q` 退出。
