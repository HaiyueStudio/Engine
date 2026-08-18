# 0025：OrbitControl 使用归一化 viewport 输入区域

- 状态：Accepted
- 日期：2026-07-18

## 背景

多 viewport 场景需要让一个 OrbitControl 只响应所属视图。为每个 viewport 叠加透明 canvas 会复制 resize、DPR、stacking、pointer capture 和触摸行为，交互层也可能与实际渲染 canvas 脱离，导致画面存在但无法稳定命中。

## 决策

1. `OrbitControlOptions.inputRegion` 使用相对输入 canvas 的归一化矩形 `{ x, y, width, height }`，默认完整 canvas。
2. 区域必须有限、具有正面积并完整位于 `[0, 1]`；无效配置在构造时拒绝。
3. pointer gesture 只能从区域内开始，wheel 也只在区域内生效。已经开始并取得 pointer capture 的拖拽可以继续越过区域边界。
4. rotate/pan 手势类型在 `pointerdown` 时由 `button/pointerType` 固定，后续移动不得依赖浏览器可能清零的 `PointerEvent.buttons`。
5. rotate/pan 灵敏度按交互区域的实际尺寸计算，而不是始终按完整 canvas 计算。
6. 多 viewport 示例直接绑定真实渲染 canvas，不再创建透明输入 canvas。

## 稳定表面

这是 `OrbitControlOptions` 的向后兼容字段扩展，不增加导出符号，stable entrypoint 数量预算保持不变。默认值保留现有完整 canvas 行为。

## 后果

- viewport 与输入共享同一 canvas、resize 和 pointer capture 生命周期。
- 同一 canvas 可以安装多个互不重叠的 OrbitControl；调用方负责避免区域重叠产生竞争。
- 区域只负责输入路由，不改变 camera、RenderView 或 scissor 所有权。
