# GUI 修复：问题、方法、结论

合并 2026-09-22/23 的滚动、帮助与文字对齐记录；原文、API diff 和环境失败见[校验归档](archive/engine-review-process-20261020.json)。这些是历史修复结论，不代表当前候选或新布局能力已经验收。

| 问题 | 方法 | 结论与边界 |
| --- | --- | --- |
| 长规则/教程无法自然滚动，拖动容易误触控件 | `GuiScrollView` 统一裁剪、偏移、wheel 与多指仲裁；帮助使用可关闭容器；已结束的指针序列不再延迟 capture | 原 GUI、浏览器和 Native 设备回归覆盖滚动、快速点击、取消、规则末尾可达与存档保持；方法见 [ADR 0102](../docs/for-ai/adr/0102-gui-scroll-view-and-help-dialog.md)，复现入口为 [GUI 示例](../examples/gui-runtime/index.html) |
| 复选框、单选框、输入框和树行文字偏离垂直中心 | 单行文字按行高居中并裁剪；Tooltip 保留换行，整体居中，超高内容从顶部显示 | 原 0.6×/1×/2× 字形位置、换行及浏览器检查通过；不是新的 OpenType shaping 或通用布局支持 |
| 数独教程重复使用上下翻页按钮 | 改用 ScrollView，步骤变化重置偏移 | 原 Android 拖动、步骤切换、提示/撤销及持久化回归通过；该次文字对齐未验证 iPhone，不能从先前滚动用例外推 |

旧记录中的 API/UI 仓库错配、包体、CLI 模式和构建超时属于当时的失败事实，已保存在归档；不把旧环境限制当作今天的操作指令，不修改原始基线或阈值。现行 GUI API 见[文档](../docs/api/gui-controls.md)。
