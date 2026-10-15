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

## 问题结论与归档

- 一个主题只维护一个活动结论入口，结构为“问题、结论、解决方法、未完成项、证据”。结论改变时原位更新，不在 README、Goal、handoff 和 review 中各追加同一条时间线。
- 每次运行的日志、启动失败、重试、完整机器检查快照放在 `artifacts/`；不为每次尝试新增一对 Markdown 和 checks JSON。可复现的最终问题和处理方法才进入活动文档。
- 已结束或已被取代的过程资料压缩到 `review/archive/`，附原路径、文件字节数和 SHA-256 清单；逐文件解包核验成功后才移除活动副本。保留失败和未采用方案的原字节，不把归档等同于验收通过。
- 接受的 ADR、许可/来源、程序直接读取的基线和当前合同不随过程记录删除。历史 ADR 只更新移动链接，通过新 ADR 取代旧决策。
- 归档同步修复 Engine 和协调计划中的引用；当前入口不得依赖 ZIP 内部文件参与正常门禁。Git 历史不重写，原始大型证据是否清理另行决定。

## 新能力的文档完成条件

1. `docs/api/` 可查到公开入口或错误码。
2. `docs/engine-guide/` 或 `docs/editor-guide/` 有任务导向说明。
3. `examples/manifest.json` 至少有一个最小示例；产品能力按要求进入 game/editor workflow。
4. 架构边界发生变化时新增 ADR。
5. 对应结构、类型、单元、构建和真实渲染门禁通过。
