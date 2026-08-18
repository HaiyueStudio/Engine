# 0002：统一包命名与发布边界

- 状态：Superseded
- 日期：2026-07-10
- 替代者：[ADR 0007：海月品牌与包作用域](./0007-haiyue-brand-and-package-scope.md)

## 背景

运行时包原名为 `webgpu-engine`，其他包使用 `@game-engine/*`。名称不一致会扩散到依赖声明、导入、文档、导出模板和未来发布流程。

## 原决策

1. 阶段二将运行时包一次性重命名为 `@game-engine/engine`。
2. 长期包集合为 `@game-engine/engine`、`@game-engine/components`、`@game-engine/ui`、`@game-engine/editor`。
3. `examples` 和 `games` 是 private 验证/展示 workspace，不作为 SDK 包发布。
4. 包间依赖只能经过 `package.json#exports` 声明的入口，禁止跨 workspace 相对导入或引用其他包的 `src`。
5. 重命名时全仓原子替换，不发布旧包名兼容空壳，不提供 alias。

## 被替代原因

阶段二执行前，产品正式命名为“海月 / Haiyue”。ADR 0007 保留本 ADR 的发布边界和原子迁移原则，但将品牌及 package scope 统一为 `@haiyue/*`。
