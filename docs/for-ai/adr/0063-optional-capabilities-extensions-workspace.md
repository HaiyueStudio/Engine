# 0063：可选能力统一归入 Extensions Workspace

- 状态：Accepted
- 日期：2026-07-31
- 替代：[ADR 0007：海月品牌与包作用域](./0007-haiyue-brand-and-package-scope.md)

## 背景

顶层 `components/` workspace 最初用于承载不应进入 engine 基础体积的高级
Component。它现在同时包含 glTF loader、Draco decoder、Worker client、
Animation3D mixer、状态机、资产适配器、插件工厂和渲染实现。这些能力并不都
是 ECS Component，继续使用 components 作为包和目录名称会错误表达架构边界，
也会使新的非组件可选能力缺少稳定归属。

项目尚未发布，没有外部兼容负担。现阶段保留旧包 alias、deprecated 转发或
双入口只会永久扩大 API、构建和文档成本。

## 决策

1. 顶层 workspace 从 `components/` 原子迁移为 `extensions/`，包名从
   `@haiyue/components` 迁移为 `@haiyue/extensions`。
2. 不保留 `@haiyue/components` package、转发入口、deprecated alias、旧场景
   import 映射或双路径解析。仓库内代码、场景、模板、测试和文档在同一阶段完成
   全量迁移。
3. `engine/src/components/` 与 `@haiyue/engine/components` 保持不变；它们表示
   engine 原生 ECS Component，不属于本次 workspace 命名迁移。
4. extension 可以拥有完整的可选能力切片，包括 Component、System、Renderer、
   loader、Worker、runtime、adapter、plugin factory、diagnostic 和 editor
   contribution。
5. 依赖方向固定为 `engine <- extensions <- editor/examples/games`。engine 不得
   导入任何 extension，extension 之间默认不得通过私有源码形成耦合。
6. 大型能力继续从明确 subpath 导入。`@haiyue/extensions` 根入口不得聚合 glTF、
   Spine、动画或其他重型实现。
7. 本轮保持现有功能 subpath 和公开符号的一一映射，只改变 workspace/package
   身份。独立发布 glTF、Spine 等能力以及稳定 extension-authoring SDK 属于后续
   独立决策。
8. ADR 0007 的 Haiyue 品牌、`@haiyue` scope、编辑器标识和原子迁移原则继续
   有效；其中 `@haiyue/components` 包集合条目由本 ADR 替代。

## Extension 准入边界

- 所有场景必需且领域无关的运行时协议属于 engine。
- 可选、可卸载、可延迟加载的完整功能属于 extensions。
- 只服务某一 extension 的 parser、codec、Worker 和 renderer 跟随该 extension。
- 编辑器专属 UI 属于 editor；extension 只提供可被 editor 消费的贡献描述。
- extension 不得以“可选”为由访问 engine workspace 私有源码，跨包依赖必须通过
  `package.json#exports`。

## 验证

- workspace dependency gate 证明 engine 不依赖 extensions。
- API diff 必须表现为 `@haiyue/components/*` 到
  `@haiyue/extensions/*` 的一一迁移，根入口不得增长。
- TypeScript、Rollup、项目导出模板、Worker URL、HTTP browser fixture、benchmark、
  Shader Language DAG 和 release gate 全部消费新 workspace。
- 除历史 review evidence 和被替代 ADR 外，活动源码与配置不得残留
  `@haiyue/components`、`components/dist` 或 `file:../components`。
