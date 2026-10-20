# 0.2.2 布局与 GUI 冻结合同

本页是 G01 的实现支持矩阵，机器数值与枚举由 [配置](../../config/layout-022-contract.json) 约束。[API 草案](api-draft.d.ts) 不是已发布声明；实际公开面仍以包 exports 和构建声明为准。架构和版本决定见 [ADR 0132](../../docs/for-ai/adr/0132-gui-layout-interaction-022.md)。

## 布局支持矩阵

| 范围 | `gui-v1` 确定规则 | 拒绝或明确差异 | 验证责任 |
| --- | --- | --- | --- |
| 盒模型 | 全部尺寸为 border-box 逻辑 px，padding/border 从内容区扣除；具名四边 | 不解析 CSS 字符串、选择器、层叠；不会把旧元组当 CSS 顺序 | G02 |
| 长度 | px、百分比、auto；百分数 100 表示一倍 | 尺寸/边距值非有限数拒绝；尺寸、padding、gap 不得为负；margin/inset 可负 | G02 |
| 百分比 | 宽高对应确定的包含块轴；四边 margin/padding 均以包含块 inline 宽为参照 | auto 内在测量阶段百分比视为 auto；最终仍不可解则报 cycle，不使用反复迭代猜尺寸 | G02 |
| 默认与约束 | 根可用空间由调用方给出；auto 为内容测量，空叶为 0；min 默认 0、max 默认无界；min 大于 max 时 min 获胜 | 不模拟 CSS 自动内容最小尺寸；DOM oracle 显式置 min-width/min-height 为 0 | G02 |
| aspect ratio | 只推导一个未指定轴，随后按该轴 min/max 钳制；两轴确定时忽略 ratio | 非正或非有限 ratio 拒绝 | G02 |
| margin/padding/gap | 行列 gap 独立；外边距不塌陷；无 auto margin | 不支持 border 百分比、负 gap、隐式样式单位 | G02 |
| Flex | 行列及反向、wrap/wrap-reverse、grow/shrink/basis、主轴/交叉轴与多行对齐 | 默认 0/1/auto；先构造行，逐行按 scaled shrink 或 grow 分配，冻结钳制项再分配；不支持 baseline/order/collapse | G02 |
| Grid | 显式 px/%/fr，minmax 的 min 为 px/%、max 为 px/%/fr；先扣 gap 再分配 fr | 固定 max 小于 min 按 min；不支持内在轨道、subgrid、dense、自动新增轨道或 auto-fit/fill | G02 |
| Grid 放置 | 从 0 起的行列、正 span；显式放置优先，自动项按树顺序逐行跳过占位；span 含内部 gap | 越界或显式占位冲突报错，不压入最后格；轨道数/树深受限 | G02 |
| absolute/relative | relative 排列后偏移；absolute 脱离流，百分比按包含块轴；双 inset 且轴尺寸 auto 时拉伸 | 同轴尺寸确定且双 inset 冲突时起始侧优先；绝对子节点不撑大 auto 父 | G02 |
| RTL/反向 | 只改变逻辑起始侧与视觉排列，存储树和焦点顺序不变 | 仅横向 writing mode；不实现 CSS vertical writing | G02/G05 |
| 隐藏 | display none 排除测量/布局/命中；GUI visible false 保留布局但不绘制/命中 | 原手动模式 visible 语义不改变 | G03 |
| 测量 | exact/at-most/unbounded；相同字体、内容代次和宽约束，换行后确定高度 | 无 DOM/GPU/字体解析依赖；测量器同步且不得改树；异常不提交半结果 | G02/G03 |
| 精度与安全 | double 逻辑矩形；最大 10,000 节点、128 深度；每节点至多 8 条测量缓存、最多 4 次约束阶段 | 重复 ID、循环、非法引用、超限和测量中止有具名 LayoutError；保留前次有效结果 | G02 |
| 便捷容器 | row/column/flow/grid/margin/center 全部表达为同一核心输入 | 不复制算法；容器唯一拥有其被管理子节点的排布 | G03 |
| 锚点预设 | 手动定位的起止锚点及 offset 计算最终区域；被流式容器管理的子节点不再使用锚点定位 | min/max 与尺寸语义一致；不在同一节点同时运行锚点和容器定位 | G03 |

DOM oracle 几何容差固定 0.02 CSS px，先使用无文字空盒；文字差分必须注入同一度量与字体代次，不能把系统字体差异当算法容差。DPR 1/2 只影响绘制边界，不改变布局输出。核心不吸附每个节点的像素；scissor 对物理起点向下取整、终点向上取整，随后与目标相交。

选取的语义参照：[W3C Flexbox](https://www.w3.org/TR/css-flexbox-1/#resolve-flexible-lengths)、[Grid](https://www.w3.org/TR/css-grid-2/#algo-track-sizing)、[Sizing](https://www.w3.org/TR/css-sizing-3/#percentage-sizing)。这里只承诺表中子集，不能以此宣称完整 CSS 兼容。

## HYA 映射与已观察差异

保留 `haiyue-responsive-layout-2d` v1、两阶段文档、实例、文本、资产、列表与滚动所有权。适配器只把布局数据传给核心；不把 TextEvaluator 或 RuntimeLayoutDocument 暴露在通用声明。

| HYA v1 输入 | 共享核心映射 |
| --- | --- |
| point / percent / hug | px / 百分数原值 / auto |
| width/height 的 fill/fraction | 主轴零 basis、对应 grow 权重；旧语义 shrink 为 0；交叉轴按旧 fill 尺寸映射 |
| grid fraction | fr 轨道；不是 Flex 长度单位 |
| RuntimeEdge | 旧 left/top/right/bottom 显式重排成具名边 |
| gap 元组 | 旧横向/纵向间距映射为 columnGap/rowGap |
| 实例/文本/列表/N-slice | 由适配器完成内容测量和后续求值，核心只返回矩形 |

四项观察必须分别保存旧值与新参考：

- `grid-gap`：旧声明接收 gap 但 Grid 不使用，属于实现缺口；新 GUI 应扣除间距。
- `grid-track-max`：旧求解只读 min；格式未完整约定增长顺序，不能直接把 CSS minmax 视作旧格式规范。新 GUI 采用表中有上限轨道分配。
- `flex-clamp-redistribution`：旧 fill 权重一次分配后钳制，不再分剩余空间；与 CSS Flex 不同。新 GUI 使用冻结/再分配。
- `flex-wrap-line-justify`：旧全体主轴对齐先于换行，换行后未逐行居中；新 GUI 先构造行再对齐。

这些差异均由单一共享求解器中的显式 `hya-v1` 配置保留，`gui-v1` 使用新语义。适配器选择配置，普通 `/layout` 消费者不能意外得到 HYA 默认值。配置差异限于上述具名阶段及已有数据单位；不得保留旧求解器副本，不得静默修正全部旧文档。若实施证明某差异无法由受限配置表达，必须回到 ADR 评审，不以 G02 完成掩盖格式变化。原 HYA 正例、资产/生命周期和 WebGPU 差分仍完整保留。

## 接入与模块归属

- Engine GUI 的拟议接入点为 `GuiRoot.installLayoutDelegate(delegate)`（返回幂等卸载函数）、`onInvalidation(listener)`（返回退订函数）与 `measureElement(element, width, height)`（复用 Engine 字体/图片度量）。装配期间禁止同一根安装第二个 delegate，卸载恢复旧手动布局并失效；提交校验所属根/节点代次，原子完成，绘制和命中使用同一矩形。
- `/layout` 独立求解，不能 import Engine、DOM、GUI、HYA、OpenType 或动画；`/gui-layout` 显式装配后通过公开 Engine 接口使用它。两者不进入 extensions 根聚合。
- GUI 文本、焦点、输入路由、主题/九宫格和拖放协议属于 Engine GUI。分隔面板、标签页和便捷容器的组合属于 `/gui-layout`，不引入业务 Editor 或平台依赖。
- N-slice 来源无关矩形/UV 数学归入 Engine `/geometry`；GUI 与 HYA 都从允许的公开方向使用。HYA 的任意 cuts、repeat/mirror 扩展仍由适配层保留，不能把现有 N-slice 降格为只支持固定九块。
- 区域更新与持久资源属于 Engine core/render 层；拟议 `RenderView.createRegion(options)` 返回受该视图拥有的 RenderRegion，ID在视图内唯一，视图销毁时连带释放。新稳定层只暴露边界、模式、失效与生命周期，不暴露帧图、GPU cache 或纹理句柄。

## 交互、主题与组合合同

以下全部为必交付，配置给出枚举和优先级，G05–G09 不再自行选择另一套语义。

| 能力 | 冻结行为 | 必须覆盖的失败路径 |
| --- | --- | --- |
| 输入路由 | GUI 消费后场景默认动作不再处理；stop/pass/ignore 分别停止、向祖先传递、忽略自身；DOM 默认行为独立 | 捕获唯一指针序列，移出区域仍归原控件；blur/pause/removal/modal 均取消 |
| 焦点 | none/click/all；Tab 按 tabIndex 再树序；方向优先显式邻居，否则前半平面角度/距离/稳定 ID；复用 InputMap | 隐藏/禁用/删除排除；Modal 限制范围并恢复有效旧焦点，否则首个可用控件；文本/滑条专用键先消费 |
| 文本 | 对外索引继续 UTF-16；用户移动/删除按扩展字素；索引夹取后向前吸附，非空选择向两端扩展 | 不拆代理对、组合字符或 ZWJ；异步剪贴板用焦点代次防止写入旧控件 |
| IME | preedit 与 committed value 分离；commit 一次；cancel 恢复前选区；失焦仅在宿主确认时提交，否则取消 | 重复 composition/input、切焦、销毁、暂停；宿主回调携带 generation |
| 软键盘 | Native 宿主拥有系统 responder；Engine 拥有编辑模型；caret rect 经区域映射到屏幕，键盘 inset 更新可用视口 | 实机中文/Latin/emoji、选择、旋转和恢复；不得更改 DPR 冒充键盘 inset |
| 主题 | default→继承资源→控件类型→局部资源→局部 style；状态 normal→hover→focus→pressed→disabled 覆盖 | 字体/图标/边距影响测量；颜色仅重绘；借用资源不销毁，生成缓存与订阅完整释放 |
| 九宫格 | 角边尺寸保留、中心拉伸、支持图集 UV；目标过小时对边按比例缩小 | 透明边、DPR、小目标、纹理替换；共享数学无复制 |
| 分隔/标签 | 比例夹在最小尺寸间；空间不足采用内容溢出/父滚动；稳定 page ID、仅活动页绘制命中 | 非活动页保留失效；删除活动页先选有效页与焦点；序列化排除回调、捕获及 GPU 状态 |
| 拖放 | payload 为业务拥有的 unknown；6 CSS px 阈值；预览位于全局覆盖层、不参与命中；释放前重新验证 | 接受仅一次 drop，拒绝/取消零次；鼠标/触摸/键盘；目标删除/隐藏、阻塞 Modal 和暂停均取消清理 |

字素参考 [UAX #29](https://www.unicode.org/reports/tr29/)，固定 Unicode 15.1 合同用例；可用平台 segmenter 需通过固定语料，不能仅以方法存在判定。缺失宿主能力应明确失败或待设备验收，不能按 UTF-16 单元回退并宣称合格。

## 分区与缓存

`demand/once/continuous/disabled` 与 visibility gate 分别管理；once 在成功提交后消费，隐藏/设备丢失不消费请求。clear 的 on-update/once/never-after-initialization 与更新频率独立，新目标必须先完整初始化才可采样。

使用自有持久颜色目标，按 premultiplied linear 合成，输出转换一次；有效颜色 load/store，销毁遵守在途安全。canvas 当前纹理不跨帧保留。MSAA 1/4 分别检查，resolve 的附件范围独立于 scissor；先交付整区域缓存，局部脏矩形不能默认绕过 resolve 或跨像素效果。

坐标以宿主逻辑区域为唯一来源；输入使用逆变换和未吸附矩形，scissor 只在绘制边界转换。跨区 Modal/Toast/拖放预览采用全局覆盖层。静态 GUI 复用纹理仍有合成成本；全部静止时不获取呈现纹理、不编码、不提交，业务/音频时钟独立。

缓存上限 8 区域、64 MiB 保留颜色（含 MSAA、resolve 及安全退役重叠），深度另计总 GPU 资源；超限显式诊断并直接重绘，不能消失内容或偷偷忽略目标。320×720 RGBA8 侧栏 resolve 为 921,600 bytes，DPR 2 为 3,686,400 bytes；4×MSAA 颜色再占其四倍，不能只报 resolve。

## 验收与设备责任

G01 冻结 HUD 128、压力 1,000、诊断 10,000 节点，25% 文字、0/1/10% 变更、三轮反序采样。当前 HYA 完整求值包含文本/动画，不能作为未来纯布局的同名时间指标；GUI audit device 只提供 CPU 和结构计数，不给出真实 GPU 时长。

HUD 在本机 60Hz 目标中分别分配 layout/measure 各 2ms P95、GUI update-to-submit 4ms P95；压力布局/测量各 8ms P95 只约束本机冻结场景；10k 要求正确、有界和报告，不作任意设备流畅承诺。数值由 16.67ms 帧预算的 1/8、1/4、1/2 分配，在优化前冻结，并与当前诊断对照。生产全帧仍继承现有 P95/P99/长帧、画质、资源、GPU 预算及具名调查项；不新增微基准跨轮噪声硬卡点。

硬结构要求：静态帧零求解、纯视觉零布局、连续场景下静态 GUI 零控件绘制/额外上传、全静止零呈现提交、销毁零残留。记录布局/测量、CPU、真实 GPU/queue wait、上传、draw/pass、缓存字节和资源退役，不能互相冒充。

浏览器/GPU 准入继续引用现有 release-matrix。另有三项明确设备责任：G06 真实桌面 IME、G06 物理 iPhone Native 输入桥、G05 真实手柄操作；最终均由 G13 汇总。这些是本版新增能力的设备证据，不把 legacy Intel 升为硬门禁，也不把缺少 iPhone 的 Windows 本机结果当作移动资格。
