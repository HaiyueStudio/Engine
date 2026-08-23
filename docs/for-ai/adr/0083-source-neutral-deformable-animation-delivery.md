# 0083：Live2D 等可变形 2D 素材离线转换为来源无关 HYA

- 状态：Accepted
- 日期：2026-08-19

## 背景

HYA 已经把 Lottie 等来源格式限定在编辑器/构建阶段，但现有 2D core 只能表达节点变换、普通 sprite、path、text、particle 和 audio，不能表达 Cubism ArtMesh 一类的静态三角拓扑与逐顶点动画。若直接在页面引入 Cubism、Spine 或其它来源 runtime，每增加一种素材就会重复 parser、时间轴、资源、渲染和生命周期，并扩大页面闭包。

Cubism Core 负责 `.moc3` 的参数到 drawable 顶点求值，且使用专有许可。第一版既不能逆向 `.moc3`，也不能把 Core 或来源 payload 包进 HYA 后继续在浏览器求值。

## 决策

1. HYA core 1.0 保持不变。可变形 2D 使用 required component extension `org.haiyue.deformable-mesh-2d@1`。
2. Extension 只表达来源无关的 textured triangle drawables：稳定 id、静态 topology/UV/index、逐帧顶点/透明度/绘制顺序、normal blend 和 alpha mask 引用。
3. 大数组使用独立 `haiyue-deformable-mesh-2d@1` sidecar。sidecar 有固定 header、JSON metadata、连续 Float32 pool 和 Uint32 index pool；parser 在创建 TypedArray/GPU owner 前验证全部字节、计数、range、引用、拓扑和有限数。
4. 第一版 delivery profile 为 `clip-baked`。构建期 evaluator 输出选定 motion/parameter recipe 的最终 drawable pose；browser runtime 不含参数图、Physics、口型、视线或来源 SDK。
5. Cubism adapter 分为两层：用户提供、许可隔离的 Core capture 工具；以及可测试、可发布的 capture-to-HYA converter。Core、`.moc3` 和官方/第三方模型不进入 npm、示例 bundle 或 HYA package。
6. Runtime 复用 `Animation2DSystem` 的时间和 owner、`Animation2DRenderSystem` 的 texture/mask/render graph。它通过 extension handler 创建通用动态 `Geometry2D` visual，不复制来源播放器。
7. 第一版不精确支持 additive/multiplicative blend、non-neutral multiply/screen color、culling、实时参数/Physics。normal 模式产生稳定 warning，strict 模式失败；不得静默宣称无损。
8. WPK 不是 canonical input。本阶段不实现 WPK 逆向、解密或保护绕过；只有经授权获得的官方 Cubism runtime asset set 才能进入 capture。
9. 新来源若能降到相同 extension，只增加 build-time adapter 和 fidelity fixture。只有出现新的来源无关语义且通过准入时才提升 HYA/runtime contract。

## 第一版边界

- 支持 stable-topology drawable、任意 UV/index、线性顶点/透明度采样、step draw order、normal alpha、多个 alpha mask source 和多个纹理。
- Cubism capture 工具支持 setup pose 和 Motion3 Parameter/PartOpacity 的 Linear、Bezier、Stepped、InverseStepped segment；Physics、Pose、Expression 组合留给后续 evaluator 扩展。
- 示例提交 HaiYue 自有的 deterministic capture fixture 与转换产物。真实 `.moc3` 验证要求使用者自行提供已获许可的 Core/模型，避免仓库替用户接受第三方许可。

## 后果

- 页面只为使用可变形 HYA 的产品支付一个通用 runtime 成本；已经转换的 HYA 在删除 Cubism adapter/Core 后仍可播放。
- Float32 全帧数据是可工作的 v1，而不是最终体积结论。量化、稀疏 dirty ranges 和自适应采样必须在真实 corpus 证据后兼容新增或提升 sidecar major。
- `@haiyue/extensions/animation` 仍是 experimental surface；新能力不进入 `@haiyue/engine` root。
- 完整实时 Live2D 交互需要独立的 source-neutral parameterized deformation ADR，不能扩写本版本语义。

## 2026-08-21 实现补充

在不改变 sidecar major、capture profile 或来源无关边界的前提下，`blendMode` 既有枚举已由运行时完整消费。`normal`、`additive`、`multiplicative` 与 alpha mask 现在属于 v1 支持范围；第 7 条中的 non-normal blend 降级约束不再适用。multiply/screen color、culling、实时参数与 Physics 仍维持原边界和结构化诊断。

## 2026-08-22 Mask minor-version 补充

HYDM 1.1 在 drawable metadata 增加来源无关的 `maskMode: alpha | alpha-inverted`。新版 decoder 继续读取 1.0，并把缺省值解释为 `alpha`；1.1 writer 总是显式写出 mode，使旧 decoder 对无法表达的 inverted mask 以 unknown minor version 失败，而不是静默按普通 mask 播放。该变化不引入 Cubism 命名或来源 runtime。

## 2026-08-23 Drawable fidelity 补充

HYDM 1.2 的逐帧 multiply/screen RGBA 已接入通用 `AnimationVisual2D` retained uniform；RGB 按冻结的 premultiplied multiply、alpha-aware screen、drawable opacity、mask coverage、framebuffer blend 顺序执行，通道 A 只保留在 pose 中。静态 culling 作为来源无关 visual pipeline 状态，以 CCW front face 在 main、mask source 与 effect source 统一执行。两项均不引入来源 runtime、Live2D component 或连续值 pipeline variant；第 7 条中的 multiply/screen color 与 culling 降级约束不再适用，真实 corpus 晋升仍由 M05 G16 负责。

## 验证

- Sidecar deterministic round-trip、unknown version、truncated/range/overflow、拓扑、mask/reference 和 limit tests。
- Capture converter 的 coordinate normalization、Motion3 sampling、strict diagnostics 和 byte-exact tests。
- Animation runtime seek/loop、mask/order、resource abort/destroy、无 Core bundle closure和真实 WebGPU example。
