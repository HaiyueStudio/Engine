# ADR 0132：0.2.2 共享布局、GUI 交互与 HYA 生产边界

- 状态：接受，2026-10-20。依据用户已指定的 0.2.2 范围、八项 GUI 能力及本次 G01 执行授权；HYA 生产完善于同日追加，逐符号准入另由 G10 冻结。
- 决策范围：G01 合同、版本安排与实施边界；不表示运行时已实现或版本已经发布。
- 具名取代：仅本版已列出的非破坏 GUI/layout stable 增量不再受“新增 stable 只能随下一 minor”的版本安排限制；其他能力仍遵循 [API 稳定规则](../api-stability.md)。不改写 Toast 的旧决定或既有 HYA 格式。

## 问题

GUI 缺少通用兄弟节点排布；HYA 参数化布局有可复用算法，但与文本、实例、资产和求值时间耦合。当前 Grid gap/max 与 Flex 钳制/换行规则不能直接宣称 CSS 支持。GUI 现有批次缓存仍每帧绘制，不能支撑静态侧栏与连续视图独立刷新。文本退格可拆开 emoji 代理对。

HYA 的 schema、独立运行时、公开包和生产证据完成度也不一致：部分参数化能力仅通过私有源码转译测试，布局诊断绘制器的色块不是生产图像/字形证据。不能把 Rive 研发分支的历史 Goal 完成状态当作当前 npm 资格。

## 决定

1. extensions 新增 focused `/layout` 纯矩形核心与 `/gui-layout` 显式适配；不进根聚合。Engine 提供算法无关 GUI 测量/排列、装卸和失效接口，不导入 extensions。核心不导入 Engine/GUI/GPU/DOM/HYA/OpenType/动画。
2. 容器、最小尺寸、Flex/Grid、输入/焦点、Unicode/IME/软键盘、主题/九宫格、分隔/标签页、语义拖放全部是本版必验能力；新声明只进入领域入口，Engine 根保持精确 30 符号。
3. `gui-v1` 使用冻结的 CSS 子集；`hya-v1` 显式映射旧单位、边距和四项已观察几何差异。两者共用单一求解器，以受限配置表达差异，不保留双份求解器、不静默修改旧格式。格式变化或不能表示的差异必须另行评审。
4. N-slice 的来源无关矩形/UV 数学归 Engine `/geometry`；HYA 适配保留任意 cuts、repeat/mirror 等既有语义。GUI 九宫格不成为 HYA 降级路径。
5. Engine 的区域更新拥有持久目标、代次和生命周期；按需/单次/连续/禁用及可见性独立。scissor 不承担跨帧存储、附件局部 clear 或 CPU 跳过。先整区域缓存，MSAA/resolve、alpha、DPR、覆盖层及安全退役都必须正确。
6. 输入采样复用 InputMap，GUI 消费后场景未处理动作才运行；捕获、Modal 焦点和拖放预览只有一个 owner。对外文本索引继续 UTF-16，交互按扩展字素处理；Native 平台输入桥属于宿主，不在 Engine 引入平台 SDK。
7. HYA 完善分为 G10 公开/格式合同、G11 组合播放与真实绘制、G12 增量/真实素材验收。复用既有时间线/状态混合器与资源 owner，不新增另一套 sampler。来源格式适配保持 build-time，不合并 Rive 研发分支或自动准入脚本/自定义 WGSL。

## 版本、符号与依赖预算

本次具名版本安排覆盖 Engine 与 extensions 的兼容新增，目标均为 0.2.2；已有 API、默认手动坐标、旧 HYA 与原 root 行为保持。拟议清单由 [机器合同](../../../config/layout-022-contract.json) 与 [API 草案](../../../review/engine-0.2.2/api-draft.d.ts) 精确列出：Engine core 68→71、geometry 53→56、gui 86→106；extensions 新 layout 13、gui-layout 11 个具名符号。这些是本能力的评审配额，不是自动填满的额度，不变更当前发布基线。

本次不新增第三方布局库、字体库或平台依赖；HYA/OpenType 继续按需加载。G13 在实际 exports、声明、包体、独立 tarball、最小示例及测试就绪后原子更新正式预算，不能单独运行 api:update 绕过边界。新增稳定能力不能以 experimental 标记替代本版交付。

HYA 的具体 focused 入口和新组合协议由 G10 按同一非破坏/来源无关范围另做具名符号评审；本 ADR 不给所有私有 HYA 模块无限导出授权。若 animation-spec 新公开格式入口实际变更，该包发布 0.2.2；否则保持 0.2.1。shader-language 未变更则保持 0.2.1；原 HYA container/sidecar 版本独立，不随 npm 版本变动。Games/Native 只升级受影响消费方，使用合格 tarball/registry 与 exact lock，不使用跨仓源码依赖。

## 验收与边界

[冻结支持矩阵](../../../review/engine-0.2.2/layout-contract.md) 规定盒模型、百分比、auto/测量、非法输入、RTL、精度、缓存、时序、主题和生命周期；[评审结论](../../../review/engine-0.2.2/README.md) 保存当前源码/构建、原始反例、浏览器 oracle 与基线索引。当前诊断不能授予候选资格或推广正式性能基线。

固定 HUD/1k/10k 场景与变更比例，在优化前冻结目标本机阶段预算；沿用生产流畅度、画质、GPU/资源硬门禁及具名调查，不追加跨轮噪声硬卡点，不放宽预算掩盖回归。CPU、真实 GPU、queue wait、draw/upload 和缓存成本分别报告。

浏览器设备范围仍来自 release-matrix；真实桌面 IME、物理 iPhone 输入桥与真实手柄分别由 G06/G05 采证，G13 汇总。设备缺失保留待验收，不能以模拟事件或 Windows 截图替代。本决定不授权发布、推送标签、修改旧基线，也不包含 App Store 游戏上架或 Editor/Rive converter 的既有任务。

### 2026-10-23 输入与按钮增量

用户明确要求 `GuiInput` 三连击全选及按钮 hover 颜色可选过渡。沿用已实现的完整主指针三击识别（500ms 相邻间隔、6px 位移容差），全选完整 UTF-16 值，密码眼睛、拖动、取消与焦点切换不累计点击。`GuiButtonOptions` / `GuiButton` 增加 `hoverTransition`（默认 false）和 `hoverTransitionMs`（默认 180ms）；非正或非有限时长即时切换。进入和离开均按 ease-out cubic 插值背景、文字、边框颜色，中途反转从当前颜色继续；按压与焦点仍使用各自状态。九宫格图片切换不做纹理交叉淡化。使用已有 GUI 帧调度，结束/隐藏/禁用后停止，不引入计时器。序列化只保存配置，过渡进度为私有运行态。新增成员沿用 `/gui` 已有符号，根入口、导出符号预算和依赖不增加。

最小示例为 `examples/gui-runtime` 的 GuiButton 属性面板；Tooltip 示例为容器和提示节点分配不同 ID，继续执行布局树唯一性检查。Tooltip 延迟到期时通过已有帧调度触发一次 paint 失效，避免状态激活却复用旧像素；待显示期间保留 demand 帧请求，出现后停止。
