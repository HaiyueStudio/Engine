# ADR 0141：GUI 视觉底座与可覆盖的组件皮肤

- 状态：接受实施，2026-11-26；用户批准 GUI 升级方案的 P0，并要求保留开发者自定义样式。
- 范围：开发工作区的 GUI P0。发布版本另定，不赋予已发布 0.2.4 或任何设备候选新的资格。

## 问题

旧 GUI 的基础调色板无法区分输入背景、浮层、强调色上的文字和开关手柄。复合控件把默认颜色写入局部 style，压过主题资源。圆角描边依赖大量轮廓顶点，文字、图片只有矩形裁剪。新增外观必须沿用原输入域、布局、局部重建、资源退休和开发者覆盖。

## 决定

1. `GuiThemeResource.createTheme(mode, density)` 返回独立主题数据。dark/light 使用海月语义色，compact/comfortable/touch 改变默认字体、留白和自动控件高度；显式高度与布局分配优先。未指定主题的 root 使用现代深色；显式旧主题保留旧控件路径，`createTheme('legacy')` 提供旧调色板。原 `DEFAULT_GUI_THEME` 保持既有值。
2. 增补 checked/selected/readOnly/open/invalid/loading 状态。冲突顺序为 checked → selected → readOnly → open → hover → focus → pressed → invalid → loading → disabled，保留旧四状态的相对次序。资源继承和类型层的顺序保持；每层独立解析状态。实例显式字段最后合并。
3. `GuiElement.getPartStyle` 与 `bindPart` 提供命名部件。绑定借用后代，不添加子节点或接管销毁；脱离 owner 后不再应用，释放句柄仅撤销自己的绑定。部件自己的实例 style 高于 owner 的部件皮肤。Label 字体字段参与原字体和测量路径；不添加第二套编辑器、布局器或输入监听。
4. 可选 borderWidth/cornerRadii/gradient/shadow/focusWidth/clipRadius 使用原 GUI 批次。形状、图片、文字共用一份 shader authoring helper；只扩展既有三个 pass，不新增静态变体。顶点 ABI 保持，附加参数按命令入表；普通批次借用视口的未用存储范围。参数变化使用原差分上传，录制、提交、取消和 device loss 沿用原 GPU owner。
5. 普通描边盒为六顶点，阴影是有界的额外解析盒；这是轻量软阴影，不宣称与 CSS 高斯阴影逐像素相同。圆角与命中使用相同几何约束；嵌套裁剪最多 128 层并同时覆盖字形、图像和形状。旋转图标仍借用原图像资源。旧 low-level stroke/roundedMesh 路径保留。
6. 字重和逻辑行高进入字体、测量、绘制与 IME 几何。现代图集按 family/weight/实际显示 DPR 与量化字号按需生成，字号有界，使用真实字体 ascent/descent 和小数字宽；旧主题保留旧度量。省略按完整字符簇截断。多字体复用原绘制顺序计划；普通单字体树保留原合批和局部重建。
7. `GuiElement.getPopupRect` 集中定位、flip/shift。Select、Tooltip 共用；关闭、模态焦点和输入消费继续归既有输入域。`setActivity` 借用现有 GUI 时钟，没有新 RAF；隐藏、裁剪离屏、禁用、reduced motion 时暂停，返回 false 或释放句柄结束。
8. P0 更新 Button/Input/Checkbox/Radio/Switch/Tooltip/Modal/Toast。新增文字／链接／图标按钮、loading、半选、输入装饰／清空／帮助文案和开关标签；不以 P0 冒充 P1/P2 的新组件家族。

## 验证与容量

保留原视觉诊断和失败记录；新图另存 P0 候选参考。验证包含样式优先级、部件借用、序列化、密度、圆角命中、IME、活动暂停、差分上传、资源清空、原有 GUI 回归和原生 GPU 画廊。全仓类型、测试、构建、API／模块／责任边界与 shader DAG、实际包消费者必须复核。

代码体积按 ADR 0135 的既有授权，在实际测量及职责／重复实现审查后分配容量；禁止借此改变性能、画质、资源和已发布资格。结果集中在 [P0 使用与验收说明](../../../review/gui-p0-20261126.md)。

实际四包安装检查仅有五项 GUI 消费者超过旧容量，Node、HYA、布局、类身份、全部公开声明与 CLI 均通过。逐项模块清单没有第二套 GUI 或 DOM/OpenType/物理依赖，保留所有原 required/forbidden/loading 约束。当前 gzip 容量分别为 gui-font 108,000 B、narrative-gui 28,000 B、gui-layout 43,500 B、gui-collections 19,000 B、gui-controls 34,000 B；原容量和审查保存在 capacityReview.priorReview，原失败报告另存。四包总容量不变。

既有三个 GUI shader pass 共用一个 authoring helper，没有新增变体。2D/UI 制品 gzip 容量由 4,800→5,600 B，Engine shader 制品总量由 12,000→12,800 B；原 stage9 合同与历史观测保留。全局 WGSL 570,000 B、76 文件、68 变体／管线及编译、性能、画质、资源门禁均保持。
