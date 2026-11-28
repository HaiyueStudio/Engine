# Engine GUI 组件与视觉升级方案

日期：2026-11-26。状态：**P0 已完成；P1A／P1B 的开发与自动化验收已完成；P2 的 18 项必做组件与自动化验收已完成；P3 的 14 项专项组件与开发自动化验收已完成**。P0 见 [底座实施说明](gui-p0-20261126.md)，P1 见 [组件实施与验收](gui-p1-20261126.md)，P2 见 [数据、表单与内容验收](gui-p2-20261127.md)，P3 见 [专项组件验收](gui-p3-20261128.md)；P1／P2／P3 的物理设备输入与 Mac／iPhone 复验归后续发布候选。范围是 Engine GUI，以及同级 UI 0.3.1 仓库的 Web Components。**保留并增强开发者自定义样式是前提。** 不预设发布版本。以下差距与对照截图记录实施前状态，后续批次清单继续有效。

## 结论

先升级可复用的视觉底座，再增加组件。当前 Tabs、Breadcrumb、Badge、Collapse、Split、虚拟 List／Tree 已存在；它们主要需要样式与变体补齐。真正缺少的高频组件是 Card、Divider、Tag、Avatar、Alert、Empty、Spin、Skeleton、ButtonGroup、Segmented，以及通用菜单／浮层／抽屉、表单和 Table。

本表覆盖 UI 根源码中 **70 个组件类**，包括 TreeNode 和两项继承 HYPopoverBase 的组件；这不是 70 个独立能力家族，也不拿文件数量作质量门禁。另列 Engine 特有或可组合的能力，避免把已有多行输入、分组选择和皮肤重复实现。

## 本次实际对照

- [深色对照截图](D:/HaiyueStudio/Engine/artifacts/gui-library-review/20261126/baseline-dark.png)：UI 源码实际构建，Engine 使用现有默认主题。
- [浅色对照截图](D:/HaiyueStudio/Engine/artifacts/gui-library-review/20261126/baseline-light.png)：Engine 仅使用现有 10 色主题映射；绘制与几何未改。
- 两组均用 Windows Chrome 158 的原生 D3D11 WebGPU，4×MSAA，8 组静态控件。GPU validation 错误为 0。截图中的自定义橙色按钮由双方各自现有样式接口配置。
- 这是视觉诊断，不是正式性能基线，也不代表 70 项全部状态／设备已经验收。深色两侧默认字号不同，不能用这两张图计算“同参数像素差”。

## 已确认的主要差距

| 问题 | 当前依据 | 应做的改造 |
| --- | --- | --- |
| 只有 10 个基础颜色 token，难以表达部件和语义状态 | [GuiTypes.ts](D:/HaiyueStudio/Engine/engine/src/gui/GuiTypes.ts)；UI 的 [浅色](D:/HaiyueStudio/UI/themes/haiyue-light.css)／[深色](D:/HaiyueStudio/UI/themes/haiyue-dark.css)还区分 elevated/input/on-accent/status/focus 等语义 | 基础色、语义色、组件部件三级 token，补间距、密度、字体、圆角、层级与动效。 |
| 开关手柄跟随正文色，浅色映射后变暗；禁用按钮文字仍较亮 | [GuiSwitch.ts:75](D:/HaiyueStudio/Engine/engine/src/gui/components/GuiSwitch.ts:75)、[GuiButton.ts:68](D:/HaiyueStudio/Engine/engine/src/gui/components/GuiButton.ts:68)与实际截图 | 拆分 thumb/track/on-content/disabled-content，按状态提供默认 skin，允许逐部件覆盖。 |
| Modal 与部分复合控件的局部默认值压过全局主题 | [GuiModal.ts:71](D:/HaiyueStudio/Engine/engine/src/gui/components/GuiModal.ts:71)、[GuiColorPicker.ts:38](D:/HaiyueStudio/Engine/engine/src/gui/components/GuiColorPicker.ts:38)；[GuiThemeResolve.ts](D:/HaiyueStudio/Engine/engine/src/gui/GuiThemeResolve.ts)把本地 style 最后合并 | 默认值进入主题层；只有开发者显式配置进入实例覆盖层。标题、正文、关闭按钮、footer 等均可独立配色。 |
| 字阶、字重与行高不完整 | [GuiStyle / GuiTheme](D:/HaiyueStudio/Engine/engine/src/gui/GuiTypes.ts)无 fontWeight/lineHeight；[GuiFontOwner.ts](D:/HaiyueStudio/Engine/engine/src/gui/GuiFontOwner.ts)按 family 管理图集 | 加 family/weight/size/DPR 的受限字体资源键、语义 title/body/caption，使用字体真实 baseline／行度量。 |
| 描边和圆角能力有限，新增阴影／圆角裁剪缺乏统一入口 | [GuiDrawCommand.ts](D:/HaiyueStudio/Engine/engine/src/gui/rendering/GuiDrawCommand.ts)只有单 radius 与纯色；[GuiBatch.ts](D:/HaiyueStudio/Engine/engine/src/gui/rendering/GuiBatch.ts)描边走 216 顶点、roundedMesh 108 顶点；[已有 shape shader](D:/HaiyueStudio/Engine/engine/src/shaders/generated/2d-ui-gui-shape.generated.wgsl)已有 smoothstep AA 与矩形 clip | 扩展可选描边／分角圆角／阴影／基础线性渐变／圆角 clip；评估用统一距离场 quad 减少复杂轮廓顶点。改良已有 AA，不能把现状误说成“没有抗锯齿”。 |
| 图标和小尺寸符号粗糙 | Checkbox 使用矩形拼接勾选，Select 等使用简化标记；对照可见 | 统一图标与指标资源，覆盖 check/minus/chevron/close/spinner，并提供图标旋转／圆弧所需的受限绘制能力；继续使用现有图片／图集生命周期。 |
| 状态层与部件层不全 | [GuiThemeTypes.ts](D:/HaiyueStudio/Engine/engine/src/gui/GuiThemeTypes.ts)仅 hover/focus/pressed/disabled；组合组件普遍只暴露根 style | 在兼容原四种状态的前提下增加 checked/selected/invalid/loading/readOnly/open 等状态和命名 parts。新字段经 API 审查，不冒充现有接口。 |
| 浮层定位与活动调度需要共用 | [GuiTooltip.popupRect](D:/HaiyueStudio/Engine/engine/src/gui/components/GuiTooltip.ts:54)与 Select 自行定位；[GuiActivityState](D:/HaiyueStudio/Engine/engine/src/gui/GuiActivityState.ts)已有增量活动状态 | 提供统一定位／flip／shift／关闭／焦点归还端口，沿用原活动状态与输入域。 |

## 开发者自定义样式合同

### 现有能力保留

当前已有 GuiRoot.theme、GuiThemeResource 的 parent/control/state 层、节点 themeResource、setStyle、NineSlice／图像皮肤，以及 GuiRenderer.registerElementRenderer。布局仍交现有 extensions/layout／gui-layout，视觉样式不另外创建布局器。

现有解析次序是：GuiRoot.theme 作为回退；祖先资源的通用层按根到父节点合并；祖先资源的组件类型层按相同方向合并；再合并节点自身资源的通用层／类型层，最后合并实例显式 style。每份资源的活动状态按 normal → hover → focus → pressed → disabled 叠加。拟新增 parts 的实例显式覆盖也放在相应部件最后。**同一字段遵循覆盖优先级，不同字段分别保留；不能笼统说局部颜色会覆盖全部 hover 等状态字段。** 新状态的冲突规则在 P0 冻结，并保留旧四种状态语义。

以下是今天已经支持的配置，开发者无需等待新组件：

```ts
const theme = new GuiThemeResource({
  normal: { fontFamily: 'system-ui', fontSize: 14 },
  controls: {
    GuiButton: {
      normal: { radius: 8 },
      hover: { backgroundColor: '#473f91' },
      disabled: { color: '#747ba8' }
    }
  }
});
root.setThemeResource(theme);
button.setStyle({ radius: 12, color: '#fff7ed' });
```

### 拟补齐能力

| 层级 | 开发者可定制内容 | 约束 |
| --- | --- | --- |
| 设计 tokens | 调色板、语义状态、字体、间距、尺寸、密度、圆角、阴影、动效 | 提供海月浅／深色预设，也支持完全自有主题；token 数据可离线映射，Engine 不依赖 UI 源码。 |
| 组件与状态 | Button、Input、Tab、TreeRow 等的 normal/hover/focus/pressed/disabled，以及选中／错误／加载等 | 显式优先级、版本与原子热更新；保留无定义时的回退。 |
| 命名部件 parts | header/body/footer/label/icon/track/thumb/popup/option/indicator 等 | 复合组件不得只让根容器可配色；不用开发者寻找内部私有 child 索引。 |
| 内容与渲染 | borrowed GuiElement 插槽、row/cell renderer、图标、NineSlice、原自定义 painter | 不转移业务内容所有权；销毁、重绑和异常要释放完整。自定义 painter 有明确 paint bounds／失效合同和安全回退。 |
| 布局／缩放 | 固定与响应式尺寸、密度、RTL、字体缩放、触控命中区 | 使用现有布局和输入域，裁剪／视觉／命中坐标一致。 |

新 parts/style API 的具体名字和类型在 P0 冻结；本方案不发布一份无法执行的“示例 API”。视觉字段、intrinsic 度量、序列化、paint cache、dirty bounds 与主题热更新必须原子支持。布局字体变化重新度量，纯颜色更新只重绘相关项，shadow/focus 的视觉外扩进入 damage bounds。

## 实现归属与复用

1. Engine GUI 只补主题解析、字体／图标资源、形状／文本／图像批次、clip、原 overlay/input/activity 端口。
2. Extensions 的 focused GUI 入口承载完整组件家族。API／子路径、声明、示例、包体和能力预算同步审查；不自动堆进默认入口。候选入口分组可按展示／反馈、弹层／菜单、数据／表单组织，名字待冻结。
3. UI 是设计与行为参考；它已有 core/portable 层可参考语义和 tokens。当前 Engine AGENTS 禁止 UI 源码依赖，因此不把 WebComponent、Shadow DOM、CSS 解析器或 UI 的独立输入／布局 owner 搬进运行时。未来若共享运行时协议，应另作明确依赖决策。
4. Popup/Drawer/Menu/Dialog 复用同一模态输入和焦点归还；Table/TreeSelect 复用现有虚拟 List／Tree；InputNumber/Form/AutoComplete 复用原 GuiInput／IME；Spin/Skeleton 使用原活动时钟。扩展层所需私有端口应经最小公开合同准入，不能跨仓／跨包导入私有源码。
5. 保持既有批量 mutation、子树 dirty、局部文字／顶点重建、hover、编辑、焦点、手柄、区域缓存和资源退休实现。新复合组件优先组合现有原语，避免因为未知 subclass／getter 把整个树推回 full scan。未知自定义 painter 保留原安全回退；可声明版本、依赖和 paint bounds 的 painter 可通过显式合同参与局部缓存。只在证据支持时抽取共享协作者，不建立第二个 GUI 渲染器。

## 分批实施

### P0：渲染、主题及现有基础组件

依赖：无；先实施本批。

交付：

- 统一浅／深色 tokens 与密度
- 边框／分角圆角／焦点环／阴影／线性渐变／圆角裁剪
- 字体字重／行高／baseline／省略及 DPR 按需图集
- 图标旋转与进度圆弧的受限绘制能力
- parts/state 样式覆盖及原皮肤接口
- 共享弹层定位与可见活动调度底座
- Button/Input/Checkbox/Radio/Switch/Tooltip/Modal/Toast 默认样式

退出条件：

- 原样式覆盖保持最高相同字段优先级
- 深浅色、尺寸和完整状态画廊
- 旧图与新图均保留，视觉变更另立候选参考
- 静态界面无新增重绘／上传，隐藏动画停止

### P1A：高频展示、反馈及现有组合组件

依赖：P0。

交付：

- Card/Divider/Tag/Avatar/Alert/Empty/Spin/Skeleton/ButtonGroup/Segmented
- 更新 Tabs/Breadcrumb/Badge/Collapse/Split/List/Tree
- 补 Image、Progress、Slider 常用变体
- Expandable 只作 Collapse 的轻量组合

退出条件：

- 每个复合组件提供命名 parts 和内容插槽／行工厂
- 内容借用、dispose、主题热更新和真实键鼠／手柄路径通过

### P1B：菜单、弹层和通知

依赖：P0。

交付：

- Menu/Dropdown/ContextMenu/Popover/Popconfirm/Drawer/Notification
- GuiModal 上的通用 Dialog 封装
- 统一 Select/Tooltip 的定位和关闭规则

退出条件：

- 一套 overlay 定位／层级／关闭／焦点归还协议
- Esc、外部点击、触摸、嵌套弹层、视口边界和输入消费正确

### P2：数据、表单及内容组合

P2 实施结果：18 项必做组件及开发自动化检查已完成，见 [验收记录](gui-p2-20261127.md)。下面两项 Select／ColorPicker 增强仍按原计划作为可选项。

依赖：P1A、P1B。

交付：

- Form/FormItem/InputNumber
- Table/Pagination/AutoComplete/TreeSelect/Cascader
- Steps/Timeline/Descriptions/Rate/Result/Ribbon
- ImagePreview/Carousel 及拖动／尺寸包装
- Select 搜索／多选和 ColorPicker HSV/alpha 可选增强

退出条件：

- IME、异步取消、稳定 key、编辑回收、键盘与手柄路由通过
- 大数据成本按活跃窗口计量；Table 不建第二个虚拟列表或布局器

### P3：可选专项

实施结果：用户已明确要求本批全部实施，14 项组件及开发自动化验收已完成，见 [专项验收](gui-p3-20261128.md)。宿主差异保持显式注入；物理设备与正式发布资格随候选复验。

依赖：P0。

交付：

- DatePicker/TimePicker/Upload/QRCode
- Anchor/Affix/Masonry/Mentions/Tour/Watermark
- VirtualKeyboard/VirtualMouse/HistoryControls/BorderBeam

退出条件：

- 由真实产品需求排期
- 宿主差异与可选依赖显式注入，默认 GUI 不加载专项后端

P1A 与 P1B 在 P0 合同冻结后可独立推进；P2 的展示类部分依赖 P1A，数据／表单与弹层交互部分同时依赖 P1B。P3 原为按产品需求选择的专项；本轮用户明确要求全部实施，以上 14 项已纳入并完成开发验收。

## 完整组件对照

下列 Engine 新名称均为能力提案，未纳入公开 API；状态描述的是 Engine 对应能力，不是给 UI 组件重新定级。

| UI 组件／源码 | Engine 当前情况 | 现有底座 | 批次 | 处理内容 |
| --- | --- | --- | --- | --- |
| [HYAffix](D:/HaiyueStudio/UI/src/affix.ts) | 可选新增 | — | P3 | 滚动吸附；先满足 Table 的固定表头，不新增另一套滚动观测器。 |
| [HYAlert](D:/HaiyueStudio/UI/src/alert.ts) | 新增 | — | P1A | 状态图标、说明、操作区和关闭事件。 |
| [HYAnchor](D:/HaiyueStudio/UI/src/anchor.ts) | 可选新增 | — | P3 | 长文档目录和定位；借用现有滚动容器。 |
| [HYAutoComplete](D:/HaiyueStudio/UI/src/auto-complete.ts) | 新增 | GuiInput 底座 | P2 | IME 安全输入、建议列表、异步取消、键盘选择。 |
| [HYAvatar](D:/HaiyueStudio/UI/src/avatar.ts) | 新增 | GuiImage 底座 | P1A | 图片／字母／图标、尺寸和失败回退。 |
| [HYBadge](D:/HaiyueStudio/UI/src/badge.ts) | 样式及能力升级 | GuiBadge | P1A | 尺寸、文字权重、描边、状态色、processing 动画及部件样式。 |
| [HYBorderBeam](D:/HaiyueStudio/UI/src/border-beam.ts) | 可选新增 | HYA 可选呈现 | P3 | 装饰效果；优先复用 HYA 和通用描边，不强制所有 GUI 加载。 |
| [HYBreadcrumb](D:/HaiyueStudio/UI/src/breadcrumb.ts) | 样式升级 | GuiBreadcrumb | P1A | 当前项、分隔符、图标、禁用色；菜单归共享弹层。 |
| [HYButtonGroup](D:/HaiyueStudio/UI/src/button-group.ts) | 新增封装 | GuiButton | P1A | 共享边框、首末分角圆角、单一焦点／禁用行为。 |
| [HYButton](D:/HaiyueStudio/UI/src/button.ts) | 样式及能力升级 | GuiButton | P0 | 字阶、密度、禁用文字、焦点环；补 loading、text/link、icon-only 变体。 |
| [HYCard](D:/HaiyueStudio/UI/src/card.ts) | 新增 | GuiElement / 布局 | P1A | 标题／extra／封面／正文／页脚、边框、阴影和 loading。 |
| [HYCarousel](D:/HaiyueStudio/UI/src/carousel.ts) | 新增 | GuiImage / 布局 | P2 | 受控页码、指示器和拖动；自动轮播可关闭并随隐藏暂停。 |
| [HYCascader](D:/HaiyueStudio/UI/src/cascader.ts) | 新增 | 虚拟树 / 弹层 | P2 | 层级选择和异步加载，沿用选择归属与共享弹层。 |
| [HYCheckbox](D:/HaiyueStudio/UI/src/checkbox.ts) | 样式及能力升级 | GuiCheckbox | P0 | 正确矢量勾选、半选态、禁用／错误／焦点及标签间距。 |
| [HYCollapse](D:/HaiyueStudio/UI/src/collapse.ts) | 样式及能力升级 | GuiCollapse | P1A | header/body/arrow/extra 分部样式、ghost／bordered、受限展开动画。 |
| [HYContextMenu](D:/HaiyueStudio/UI/src/context-menu.ts) | 新增 | 共享弹层底座待补 | P1B | 右键／长按菜单，图标、快捷键、分隔项、子菜单与焦点返回。 |
| [HYDatePicker](D:/HaiyueStudio/UI/src/date-picker.ts) | 可选新增 | — | P3 | 日期／范围、locale 和键盘日历；先明确值与时区合同。 |
| [HYDescriptions](D:/HaiyueStudio/UI/src/descriptions.ts) | 新增 | 布局 / GuiLabel | P2 | 只读字段、横纵排布、列数与空值呈现。 |
| [HYDialog](D:/HaiyueStudio/UI/src/dialog.ts) | 新增组合封装 | GuiModal | P1B | 通用 header/body/footer 内容；复用原 modal trap。 |
| [HYDivider](D:/HaiyueStudio/UI/src/divider.ts) | 新增 | 形状 / GuiLabel | P1A | 横纵分隔、文字、留白与可配置线宽。 |
| [HYDraggable](D:/HaiyueStudio/UI/src/draggable.ts) | 新增组合封装 | GuiElement dragSource/dropTarget | P2 | 复用现有拖放控制器，补约束、句柄与反馈。 |
| [HYDrawer](D:/HaiyueStudio/UI/src/drawer.ts) | 新增 | GuiModal / 共享弹层 | P1B | 四向抽屉、内容插槽、遮罩、Esc 和焦点恢复。 |
| [HYDropdown](D:/HaiyueStudio/UI/src/dropdown.ts) | 新增 | 共享菜单 / 弹层 | P1B | 点击／悬停触发、定位、关闭规则与受控打开状态。 |
| [HYEmpty](D:/HaiyueStudio/UI/src/empty.ts) | 新增 | GuiImage / GuiLabel | P1A | 空列表／无搜索结果、说明和可选操作内容。 |
| [HYExpandable](D:/HaiyueStudio/UI/src/expandable.ts) | 新增轻量封装 | GuiCollapse | P1A | 单项展开器，复用折叠状态和内容生命周期。 |
| [HYFormItem](D:/HaiyueStudio/UI/src/form-item.ts) | 新增 | GuiInput / 布局 | P2 | label、required、help、error 和字段级校验反馈。 |
| [HYForm](D:/HaiyueStudio/UI/src/form.ts) | 新增 | 字段适配端口 | P2 | 同步／异步校验、取消和重置；业务数据由调用方持有。 |
| [HYHistoryControls](D:/HaiyueStudio/UI/src/history-controls.ts) | 可选组合封装 | GuiButton / 外部历史端口 | P3 | 只呈现 undo/redo/history，历史与业务命令归调用方。 |
| [HYImagePreview](D:/HaiyueStudio/UI/src/image-preview.ts) | 新增 | GuiImage / GuiModal | P2 | 预览、缩放、平移、切图；借用资源并复用模态输入。 |
| [HYImage](D:/HaiyueStudio/UI/src/image.ts) | 样式及能力升级 | GuiImage / GuiNineSlice | P1A | fit、圆角裁剪、加载／失败回退，保留自有／借用资源合同。 |
| [HYInput](D:/HaiyueStudio/UI/src/input.ts) | 样式及能力升级 | GuiInput | P0 | 统一字体、密度、边框与焦点；prefix/suffix、clear、error/help；已有多行、密码和 IME。 |
| [HYMasonry](D:/HaiyueStudio/UI/src/masonry.ts) | 可选新增 | extensions/layout | P3 | 确有内容需求时扩展共享布局算法，不建第二个布局器。 |
| [HYMentions](D:/HaiyueStudio/UI/src/mentions.ts) | 可选新增 | GuiInput / 共享弹层 | P3 | 提及建议、候选替换及 IME／异步查询边界。 |
| [HYMenu](D:/HaiyueStudio/UI/src/menu.ts) | 新增 | 共享菜单模型待补 | P1B | 单选、展开、子项、图标、快捷键与分隔线。 |
| [HYModal](D:/HaiyueStudio/UI/src/modal.ts) | 样式及能力升级 | GuiModal | P0 | 移除浅色硬编码，统一遮罩／标题／操作区；基础之上提供通用 Dialog。 |
| [HYNotification](D:/HaiyueStudio/UI/src/notification.ts) | 新增 | GuiToast / 活动时钟 | P1B | 持久通知、操作、位置／堆叠，复用消息生命周期。 |
| [HYPagination](D:/HaiyueStudio/UI/src/pagination.ts) | 新增 | GuiButton / 布局 | P2 | 受控页码、页大小、总数、快速跳转。 |
| [HYPopconfirm](D:/HaiyueStudio/UI/src/popconfirm.ts) | 新增组合封装 | Popover / GuiButton | P1B | 确认／取消、异步提交状态，复用同一定位和焦点归还协议。 |
| [HYPopover](D:/HaiyueStudio/UI/src/popover.ts) | 新增 | 共享弹层底座待补 | P1B | 锚定浮层、边界避让、交互内容和 focus／click／hover 触发。 |
| [HYProgress](D:/HaiyueStudio/UI/src/progress.ts) | 样式及能力升级 | GuiProgress | P1A | 细进度条、状态、label 部件、circle 与 indeterminate。 |
| [HYQRCode](D:/HaiyueStudio/UI/src/qr-code.ts) | 可选新增 | 可选编码／纹理适配器 | P3 | 按需依赖及授权审查；不进入默认 GUI 闭包。 |
| [HYRadio](D:/HaiyueStudio/UI/src/radio.ts) | 样式及组合升级 | GuiRadio | P0 | 圆环和标记、禁用／焦点；基于原 group 增加 RadioGroup 组合。 |
| [HYRange](D:/HaiyueStudio/UI/src/range.ts) | 能力升级 | GuiSlider | P1A | 补竖向、双手柄、刻度及值提示，保留 onChange/onCommit。 |
| [HYRate](D:/HaiyueStudio/UI/src/rate.ts) | 新增 | GuiImage / 图标 | P2 | 整星／半星、只读、清除及键盘控制。 |
| [HYResizable](D:/HaiyueStudio/UI/src/resizable.ts) | 新增组合封装 | GuiSplitPanel / 原指针路由 | P2 | 尺寸约束与句柄，借用原 capture，不另设全局监听器。 |
| [HYResult](D:/HaiyueStudio/UI/src/result.ts) | 新增 | GuiImage / GuiLabel / 按钮 | P2 | 结果页／错误页的图标、说明与操作区。 |
| [HYRibbon](D:/HaiyueStudio/UI/src/ribbon.ts) | 新增 | GuiBadge / Card | P2 | 卡片角标、位置、颜色和内容，不重复通知状态逻辑。 |
| [HYSegmented](D:/HaiyueStudio/UI/src/segmented.ts) | 新增 | GuiButton / 选择模型 | P1A | 图标／文字、单选、密度、禁用及滑动选择背景。 |
| [HYSelect](D:/HaiyueStudio/UI/src/select.ts) | 能力及样式升级 | GuiSelect | P1B | 箭头／选项样式、边界避让；搜索／多选与虚拟化在 P2 补。 |
| [HYSkeleton](D:/HaiyueStudio/UI/src/skeleton.ts) | 新增 | 形状 / 活动时钟 | P1A | 文本／头像／卡片骨架；离屏和 reduced-motion 时停止动画。 |
| [HYSpin](D:/HaiyueStudio/UI/src/spin.ts) | 新增 | 图标 / 活动时钟 | P1A | 加载指示与容器遮层，不新建每组件 RAF。 |
| [HYSplit](D:/HaiyueStudio/UI/src/split.ts) | 样式升级 | GuiSplitPanel | P1A | 分隔手柄、hover／focus、密度和可用命中区域。 |
| [HYSteps](D:/HaiyueStudio/UI/src/steps.ts) | 新增 | 布局 / 图标 | P2 | 流程进度、状态、可选点击与自定义标题／描述。 |
| [HYSwitch](D:/HaiyueStudio/UI/src/switch.ts) | 样式及能力升级 | GuiSwitch | P0 | 手柄颜色独立于正文色，统一尺寸；补 loading 与开关文字。 |
| [HYTable](D:/HaiyueStudio/UI/src/table.ts) | 新增 | createGuiVirtualList / 布局 | P2 | 列定义、排序／筛选／选择／编辑／固定表头；按稳定 key 回收。 |
| [HYTabs](D:/HaiyueStudio/UI/src/tabs.ts) | 能力及样式升级 | GuiTabContainer | P1A | 已有左右图标和关闭；补 disabled、位置、指示线／卡片变体和 parts。 |
| [HYTag](D:/HaiyueStudio/UI/src/tag.ts) | 新增 | GuiLabel / GuiButton | P1A | 语义色、图标、关闭和可选选中态。 |
| [HYTimePicker](D:/HaiyueStudio/UI/src/time-picker.ts) | 可选新增 | — | P3 | 时间选择与格式／locale，和日期选择共同审查。 |
| [HYTimeline](D:/HaiyueStudio/UI/src/timeline.ts) | 新增 | 布局 / 虚拟列表 | P2 | 时间线、状态和自定义内容；长历史复用虚拟化。 |
| [HYToast](D:/HaiyueStudio/UI/src/toast.ts) | 样式及服务升级 | GuiToast | P0 | 图标、语义色、密度和布局；堆叠服务与 Notification 共用调度。 |
| [HYTooltip](D:/HaiyueStudio/UI/src/tooltip.ts) | 样式及定位升级 | GuiTooltip | P0 | 阴影、箭头、边界避让、统一延迟与触摸／键盘呈现。 |
| [HYTour](D:/HaiyueStudio/UI/src/tour.ts) | 可选新增 | 共享弹层 / 锚点 | P3 | 引导步骤、聚焦及遮罩洞，需真实输入验证。 |
| [HYTreeNode](D:/HaiyueStudio/UI/src/tree-node.ts) | 并入现有树升级 | GuiTreeNode / 虚拟树数据 | P1A | 作为 Tree 数据项处理，不增加第二个树运行时。 |
| [HYTreeSelect](D:/HaiyueStudio/UI/src/tree-select.ts) | 新增 | createGuiVirtualTree / 共享弹层 | P2 | 树形选择、搜索和按需加载。 |
| [HYTree](D:/HaiyueStudio/UI/src/tree.ts) | 样式及能力升级 | GuiTree / createGuiVirtualTree | P1A | 图标、缩进、选中／焦点、行 parts；保留虚拟树与编辑回收。 |
| [HYUpload](D:/HaiyueStudio/UI/src/upload.ts) | 可选宿主组件 | 文件选择／上传宿主端口 | P3 | 浏览器与 Native 差异显式适配，网络／权限由应用提供。 |
| [HYVirtualKeyboard](D:/HaiyueStudio/UI/src/virtual-keyboard.ts) | 可选宿主组件 | GuiInput / 既有输入路由 | P3 | 游戏自定义键盘；原生文本优先沿用系统键盘与 IME。 |
| [HYVirtualList](D:/HaiyueStudio/UI/src/virtual-list.ts) | 样式及能力升级 | createGuiVirtualList | P1A | 空态、行／选中／编辑样式；保留回收状态和可见窗口成本。 |
| [HYVirtualMouse](D:/HaiyueStudio/UI/src/virtual-mouse.ts) | 可选输入组合 | 既有输入层 / GuiInputDomain | P3 | 游戏手柄光标与按钮映射；接原路由，不新增采样器。 |
| [HYWatermark](D:/HaiyueStudio/UI/src/watermark.ts) | 可选新增 | 文本 / 图像批次 | P3 | 共享图集／纹理和缓存，避免逐项独占 GPU 资源。 |

### Engine 特有／可组合项

| 项目 | 当前情况 | 现有底座 | 批次 | 处理内容 |
| --- | --- | --- | --- | --- |
| InputNumber | 拟新增组合 | GuiInput | P2 | 沿用现有编辑器／IME，在提交边界格式化；不是新文本输入宿主。 |
| TextArea | 已有能力 | GuiInput.multiline | P0 | 增加外观／便捷封装即可，不创建第二个编辑器。 |
| Icon/IconButton | 已有图片／按钮底座 | GuiImage / GuiButton.style.icon | P0 | 补统一图标资源与语义尺寸；不默认打入整个 UI 图标库。 |
| RadioGroup | 已有分组机制 | GuiRadio.group | P1A | 可选组合 API，复用原选择归属。 |
| ColorPicker | 已有 RGB/HEX 编辑器 | GuiColorPicker | P0/P2 | 先统一校验色和内部样式；HSV 与透明度另作可选增强。 |
| HelpDialog/ScrollView/NineSlice | 已有，更新样式并保留皮肤 | Engine GUI | P0 | 滚动条、帮助弹窗与图像皮肤使用同一主题，布局继续现有 owner。 |

## 验收与完成定义

- **视觉**：同主题、同字体文件、字号／字重、尺寸、DPR、背景下建立 DOM／Engine 双画廊，覆盖 normal/hover/pressed/focus/disabled/checked/invalid/loading、图标左右／仅图标、长文本、中文与英文、浅深色。当前两张诊断图仅说明差距，不能作完整对齐通过证据。
- **度量草案**：布局、文字 baseline 和控件尺寸建议误差不超过 1 逻辑像素；视觉边缘／字形像素容差须用匹配样例测量后冻结。保留旧参考，另建具名候选参考，不修改容差掩盖差异。跨浏览器字体抗锯齿差别不等于设计不一致，也不宣称逐像素复刻 DOM。
- **自定义**：每个组件验证全局、子树、实例、状态和 parts 覆盖；两种独立自定义皮肤、NineSlice、自定义 painter、多主题并存、主题热更新、销毁释放。现有 setStyle 和 resource 优先级有兼容回归。
- **输入与跨端**：鼠标／触摸／键盘／手柄沿原输入域；Windows/Mac 真实 IME，以及 iPhone 旋转、遮挡、后台恢复、候选取消、focus/overlay 路由。Form/Select 异步请求须支持取消和最新请求身份。
- **性能／资源**：沿用现有静态、稀疏变化、全量变化、大列表与区域缓存场景；记录 CPU 变更／布局／绘制编码、GPU/queue、上传、draw/pass、分配和资源残留。静态不新增上传；不可见动画停止；纯颜色不重排版；有界字体／阴影缓存；GPU 残留与 validation 错误为 0。没有本轮正式压力测试或新性能基线。
- **发布**：新增公开合同、序列化回退、focused consumer 及默认导入闭包、四包类型／构建／测试和原门禁齐备。功能增长后的容量以实测及重复实现审查决定，不预先提高预算，也不按文件数定质量。

## 交付材料与本轮边界

[机器可读完整清单](D:/HaiyueStudio/Engine/artifacts/gui-library-review/20261126/component-plan.json)、[源码目录与哈希](D:/HaiyueStudio/Engine/artifacts/gui-library-review/20261126/inventory.json)及两张实际对照图已保存。UI 组件源码只读；本轮只新增此方案和诊断材料，没有修改或新增产品 GUI 功能、公开接口、预算、基线，也没有推送或发布。
