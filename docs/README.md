# GameEngine 文档

海月是面向长期演进的 WebGPU 游戏引擎与场景编辑器。文档按读者和使用目的分成四个入口；请从与你当前任务对应的入口开始，不要按文件名全量阅读。

| 我想做什么 | 从这里开始 | 内容边界 |
| --- | --- | --- |
| 使用编辑器创建、调试和导出项目 | [Editor Guide](./editor-guide/README.md) | 面向编辑器用户的任务教程 |
| 使用 TypeScript 和引擎开发游戏 | [Engine Guide](./engine-guide/README.md) | 面向代码开发者的教程、功能指南和 recipes |
| 查询类、接口、参数和错误码 | [API Reference](./api/README.md) | 只提供可查询的 API 事实，不承担教学职责 |
| 理解架构、研发状态或参与项目维护 | [For AI & Maintainers](./for-ai/README.md) | 架构约束、ADR、模块边界、门禁和研发状态 |
| 查看当前里程碑、Goal 和执行依赖 | [Milestones](../milestones/README.md) | 动态实施计划、并行边界和完成条件 |

## 推荐学习路径

- 第一次使用编辑器：依次阅读 [启动编辑器](./editor-guide/getting-started.md) 和 [核心工作流](./editor-guide/core-workflow.md)。
- 第一次通过代码开发：依次阅读 [Engine Guide](./engine-guide/README.md) 和 [第一个场景](./engine-guide/getting-started.md)。
- 从公共 npm 包验证完整生命周期：阅读[新用户黄金路径](./engine-guide/consumer-walkthrough.md)。
- 判断是否受支持或准备 issue：阅读[已知限制](./engine-guide/known-limitations.md)和[故障排查](./engine-guide/troubleshooting.md)。
- 已经知道类型名：直接进入 [API Reference](./api/README.md)，不要从教程反查完整签名。
- 修改引擎或编辑器架构：先阅读 [For AI & Maintainers](./for-ai/README.md) 和相关 ADR。
- 执行已规划阶段任务：先选择 [Milestones](../milestones/README.md) 中状态为 `ready` 的 Goal。
- 从源码运行或贡献：阅读[贡献与验证](./for-ai/contributing.md)。

## 文档维护规则

1. Guide 回答“怎样完成任务”，API 回答“类型和参数是什么”，For AI 回答“为什么这样设计以及修改时必须保持什么”。
2. 同一事实只保留一个权威来源；其他文档使用链接引用，不复制长期维护的参数表或架构约束。
3. Engine Guide 中的代码必须使用 stable 入口；依赖 `experimental` 时必须显式标注。
4. API 文档以发布包的 TypeScript 声明和 `package.json#exports` 为准，手写页面只补充索引、错误码和稳定性说明。
5. 新增 stable 功能必须同时提供 API 声明、最小 example、对应 Guide 页面和自动化证据。

详细的归档与更新规则见 [文档维护约定](./for-ai/documentation-conventions.md)。
