# ADR 0115：可选国际化运行时与 GUI 资源绑定

- 状态：Accepted
- 日期：2026-10-02
- 入口：`@haiyue/extensions/i18n`

## 决策

国际化归属 extensions，Engine 核心不反向依赖。根入口保持不变，新增聚焦子路径。
无 DOM 的 I18n 负责语言包、显式回退链、文本解析、格式化和语言变更；GUI 适配通过公开
`@haiyue/engine/gui` 与 `@haiyue/engine/assets` 类型和 setter 接入，不另建渲染器或资源缓存。

语言包是 schemaVersion 1 的 JSON：BCP 47 locale、平铺 messages 与 assets。游戏拥有 key、
翻译和资源路径。Rust 可复用数据协议，但本变更不实现 Rust 运行时。

## 不变量

- 不自动把中文脚本/地区合并。应用显式配置回退链，环通过去重终止。
- setLocale 先加载配置链，失败保留当前语言；较新切换和销毁使旧结果失效。
- 图片有单独的异步 ready；语言提交不等待所有图片，旧图保留到新图可用。不得宣称全界面原子切换。
- 资源通过租约 release 释放；GUI 绑定使用稳定纹理源与 version，保持逻辑尺寸与 UV。
- 文本仅通过 setText 标记目标节点；无需逐帧执行，不强制 GUI 根重新布局。
- GUI 节点没有销毁通知；节点移除/场景退出必须 dispose 绑定或 abort 场景信号。
  I18n.dispose 也会清理全部绑定。框架不能推测节点 detach 是临时移动还是永久销毁。
- 图片描述是供宿主消费的语义文本，不代表 GPU GUI 已实现系统读屏支持。

## API 审阅范围

7 个值导出：I18n、validateLocalePack、checkLocalePacks、collectLocaleCharacters、bindI18nText、bindI18nImage、createI18nTextureLoader。
12 个契约类型，合计 19 个符号。仅新增 ./i18n 能力预算，不改变现有入口限制。
平台适配用注入 loader；核心不读取 navigator、localStorage 或文件系统。
复数使用 CLDR 类别 + other，不实现 ICU MessageFormat；RTL 排版、字体自动切换、翻译编辑器另行设计。

## 验证

类型契约与单元测试覆盖 JSON 校验、回退、插值、复数、异步竞争、失败保留、租约释放、局部 dirty。
[可运行示例](../../../examples/i18n/README.md)用 GPU GUI 演示三种语言与标题图片，`?verify=1` 运行浏览器验收。
[API 与证据](../../../review/api/i18n-validation.md)。
