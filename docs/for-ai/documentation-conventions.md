# 文档维护约定

## 受众边界

- `for-ai/`：内部架构、不变量、研发状态索引、测试和发布门禁。
- `editor-guide/`：使用编辑器完成具体任务，不解释内部 Store 或渲染协调器。
- `engine-guide/`：使用公开代码 API 完成具体任务，不复制完整类型签名。
- `api/`：符号、参数、返回值、错误码和稳定性，不编排长教程。
- `milestones/`：动态的阶段 Outcome、Goal、依赖、write scope 和验收条件，不复制 ADR 或正式 evidence。

## 文件和链接

- 目录及文件名使用小写 kebab-case。
- 每个目录必须有 `README.md`，并提供建议阅读顺序。
- 仓库内使用相对链接；移动文档时必须运行链接检查并同步结构门禁中的路径。
- 提交文档修改前运行 `npm run docs:check`；该门禁同时校验四类目录、相对链接和错误码 `docsPath`。
- Guide 必须链接到可运行的 `examples/` 或 `games/`；示例名称以 manifest 为准。

## 内容生命周期

- ADR 一经接受不直接改写决策历史；通过新 ADR 标记 superseded。
- 活动实施状态放在 `milestones/`，未规划候选项放在 `todos/`，评审结果和数值基线放在 `review/`；For AI 页面只提供稳定索引。
- API 参数以构建后的 `.d.ts` 和 stable exports 为权威来源。
- 教程中的代码必须能通过当前 stable API 编译；涉及 experimental 时注明稳定性风险。
- 删除 API 时同步删除旧教程、旧入口和兼容写法，不保留“新旧两套”示例。

## 新能力的文档完成条件

1. `docs/api/` 可查到公开入口或错误码。
2. `docs/engine-guide/` 或 `docs/editor-guide/` 有任务导向说明。
3. `examples/manifest.json` 至少有一个最小示例；产品能力按要求进入 game/editor workflow。
4. 架构边界发生变化时新增 ADR。
5. 对应结构、类型、单元、构建和真实渲染门禁通过。
