# ADR 0142：GUI P1 组件组合与共享浮层

- 状态：接受实施，2026-11-26；用户要求完成既定方案 P1A 与 P1B。
- 范围：开发工作区的新组件和既有 GUI 增量；不为已发布版本重新赋予资格。新增 stable 能力随后续 minor 发布。

## 问题

P0 已补齐视觉底座，但展示／反馈组件、通用菜单和浮层尚不完整。复合组件需要借用业务内容、保持主题和实例覆盖，并复用原布局、输入、字体、活动和 GPU 生命周期。

## 决定

1. `@haiyue/extensions/gui-display` 单独承载 Card、Divider、Tag、Avatar、ImageView、Alert、Empty、Spin、Skeleton、ButtonGroup、Segmented；`./gui-overlays` 承载 Menu、Dropdown、ContextMenu、Popover、Popconfirm、Dialog、Drawer 和 NotificationCenter。均不聚合到根入口。既有 `./gui-controls` 仅增加委托 Collapse 的 Expandable；`./gui-collections` 增加只读行状态合同。
2. 默认皮肤通过 `GuiElement.setDefaultSkin` 进入既有解析器的默认层，主题资源、parts 和实例字段继续覆盖它。`getTheme` 返回只读 token 快照；`isEffectivelyVisible` 使用原可见活动判定，不创建观察器。
3. 可见活动沿用原时钟。默认 activity 随减少动效策略暂停；显式 `{motion:false}` 的延迟／通知计时使用同一时钟，仍随隐藏、禁用和离屏暂停。没有组件 RAF、interval 或私有输入采样器。
4. 所有浮层继续使用原 GuiModal 身份与 GuiFocusManager。子菜单共享父模态宿主内的面板，不增建焦点栈。纯 `getDialogRect`／`getContentLayoutRect` 与带只读 anchor 矩形的 `getPopupRect` 让原布局 delegate 在提交前计算位置；绘制、裁剪和命中使用同一结果。面包屑菜单借用同一 Menu 实现；Select 失焦／取消关闭，Tooltip 也检查目标可见性。
5. 借用的业务节点、图像、焦点域不被销毁。组件显式 dispose 释放全部句柄；提供 root 的展示组件和所有浮层通过 `GuiRoot.onDispose` 挂到既有根销毁观察表。类构造结束前不注册展示组件生命周期，失败路径退还内容。
6. Image 的 fit、Progress 的圆环／状态／不定进度、Slider 的垂直／范围／刻度／数值提示复用原 CPU 批次和 shader。字段同时进入失效、字体覆盖、视觉外扩和序列化。不增加 GPU pass 或静态变体。
7. Tabs、Breadcrumb、Badge、Collapse、Split 提供命名部件和现代默认样式。Collapse 默认保留即时展开；可选 0–500 ms 动画仅在已有或显式内容高度可用时使用原布局器插值，未知高度立即正确展开。List／Tree 继续使用原行池与纯窗口；可选 setState 不重新绑定编辑器，深度在原模型索引中计算一次。

## 准入与验证

API 准入为 gui-display 25、gui-overlays 20、gui-controls 14、gui-collections 10 个符号，均零新增储备；Engine 根和既有其它符号额度保持。实际声明、消费者和最小示例必须共同通过，不能只更新基线。

验证包括样式覆盖、借用／构造回滚、热更新、通知计时、原键鼠／手柄动作路径、嵌套菜单、Esc／外部点击／触摸／焦点返回、行回收与编辑保留、真实 WebGPU 图像和静态上传。代码容量先测量和审查重复职责，再按 ADR 0135 的现有授权安排；不改变性能、资源或画质预算。测量与最终限制集中在 `review/gui-p1-20261126.md`，原失败保持。
