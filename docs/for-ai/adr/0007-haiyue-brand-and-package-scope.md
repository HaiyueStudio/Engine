# 0007：海月品牌与包作用域

- 状态：Superseded
- 日期：2026-07-10
- 替代：[ADR 0002：统一包命名与发布边界](./0002-package-naming-and-release-boundaries.md)
- 替代者：[ADR 0063：可选能力统一归入 Extensions Workspace](./0063-optional-capabilities-extensions-workspace.md)

## 背景

产品方向已经确定为 3D 优先，引擎正式命名为“海月”。阶段二正处在首次对外发布前的无兼容负担窗口，品牌、包名和公开符号如果继续分裂，会形成长期认知与发布成本。

## 决策

1. 中文产品名使用“海月”，拉丁字母品牌名使用 `Haiyue`。
2. SDK 与工具包统一使用 npm scope `@haiyue`：
   - `@haiyue/engine`
   - `@haiyue/components`
   - `@haiyue/ui`
   - `@haiyue/editor`
3. `examples` 与 `games` 继续作为 private workspace，内部名称分别为 `@haiyue/examples` 与 `@haiyue/games`。
4. 根 workspace 名称使用 `haiyue-monorepo`；引擎公开构造器使用 `HaiyueEngine`，UI 注册函数使用 `defineHaiyueUI`。
5. 编辑器、导出模板、存储键、内部 MIME 类型和运行时格式标识同步使用 `haiyue` 命名；不保留旧标识解析分支。
6. 品牌视觉采用淡蓝色新月。编辑器左上角显示品牌标识，浏览器标签使用同源 favicon。
7. 包重命名和公开符号调整必须全仓原子替换；不提供旧包空壳、旧符号 alias、deprecated 转发或双入口。

## 后果

- 代码、文档、编辑器与发布物具有同一品牌来源。
- 包边界继续遵守 ADR 0002 中的 exports-only 和 workspace 依赖方向原则。
- 所有破坏式命名调整在阶段二一次完成，不把临时迁移机制带入后续阶段。
