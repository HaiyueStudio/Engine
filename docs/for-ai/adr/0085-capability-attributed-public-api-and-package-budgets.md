# ADR 0085：公共 API 与包体预算按已准入能力归因

- 状态：Accepted
- 日期：2026-08-20
- 影响范围：public npm packages、API baseline、tarball/consumer budgets、M04 G10
- 替代结论：ADR 0061 中 Shader Language 保持 private 的结论；ADR 0068 中 UI 与 Shader Language 保持 private、公共包固定为两个的结论

## 背景

既有 API 与包体门禁把一次历史测量直接当作长期上限。Engine 的 tarball 文件数为 `549/549`，Animation
Spec 为 `31/31`；即使新增能力拥有明确 owner、focused entrypoint、consumer 和真实产品证据，也会因为没有
容量余量而失败。反过来，单纯放大一个全局数字又会掩盖 root 聚合、内部实现泄漏和无关依赖进入 bundle。

多仓迁移后，`@haiyue/ui` 与 `@haiyue/shader-language` 已有独立仓库/构建边界、public manifest 和 focused
exports，但 release scope 与 API baseline 仍保留旧 private 状态。M04 同时新增 experimental
`@haiyue/extensions/ray-tracing`，需要明确它是否扩大 Engine 稳定入口。

## 决策

1. 公共 npm 包为 `@haiyue/engine`、`@haiyue/animation-spec`、`@haiyue/extensions`、
   `@haiyue/shader-language` 与 `@haiyue/ui`。应用、examples 与 games 仍是独立静态制品，不变成 npm 包。
2. 所有公共包只发布 `dist` 声明与 JavaScript，以及显式 README、LICENSE、schema 或 CLI 文件；
   `package.json#exports` 不提供 `source` condition，`files` 不包含 `src`。
3. Engine root 继续精确等于 ADR 0035 的 30 个黄金路径概念。能力增长不得消费 root “名额”；它使用
   focused stable subpath，或在成熟前使用 focused experimental subpath。
4. [`config/public-api-capability-budgets.json`](../../../config/public-api-capability-budgets.json) 为每个 public
   entrypoint 登记 capability group、稳定性、已审查 symbol 数和 growth reserve。API baseline 仍阻止任何未审查
   diff；reserve 不是免审配额，只用于判断一个已批准能力是否出现不合理的 facade 膨胀。
5. [`config/engine-package-budget.json`](../../../config/engine-package-budget.json) 的 package envelope 等于
   “同一 dist-only candidate 的实测容量 + 明示增长储备”。新增能力必须同时更新能力归属、实测容量、reserve
   理由、packed consumer 与 API baseline；不能因为一次失败直接提高上限。
6. 总 tarball 容量与 consumer closure 分开。包随能力增加可以增长，但 root、focused import 的 gzip budget
   只在该调用路径确实需要新增代码时增长；tree-shaking、默认 bundle 不携带可选能力仍是硬门禁。
7. Ray tracing 保持 experimental `@haiyue/extensions/ray-tracing`，只公开 11 个责任 namespace；不进入
   `@haiyue/engine` root、默认 raster、默认 Editor 或 Games closure。
8. 能力删除或拆包时可以在审查后降低预算。预算不是必须单调增加的 KPI；它表达当前已承诺能力的可解释容量。

## 后果

- 后续迭代先回答“能力属于哪个入口、稳定性是什么、consumer 需要什么”，再决定 API 与容量增量。
- API baseline、entrypoint capability policy、dist-only tarball、consumer closure 与 release scope 形成同一套审查链。
- UI 与 Shader Language 获得独立版本/rollback unit；它们不因此成为 Engine runtime 依赖。

## 验证

- `node --test scripts/engine-package-policy.test.mjs`
- `npm run api:check`
- `npm run verify:engine-package`
- `npm run release:scope:check`
- `npm run check:boundaries`
