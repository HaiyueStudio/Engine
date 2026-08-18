# 0030：网页动效使用独立可扩展运行时中间格式

- 状态：Superseded by [0031](./0031-animation-vector-and-compositing-runtime.md)
- 日期：2026-07-21

## 背景

Lottie 是以 JSON 表达矢量动画和相关素材的交换格式，其 animation 顶层包含 layer、asset、帧率与入出点等创作模型信息；属性还要同时表达静态值和关键帧值。Galacean Effects specification 则覆盖 composition/item/component、粒子、Spine、模型、timeline、animation graph 等另一套能力集合。让引擎分别在页面加载两套甚至更多来源格式，会复制解析、校验、时间轴、资源和降级策略，并使主包随导入格式数量增长。

参考：

- Lottie format documentation: <https://lottiefiles.github.io/lottie-docs/Introduction/>
- Lottie composition model: <https://lottiefiles.github.io/lottie-docs/composition/>
- Galacean Effects specification: <https://github.com/galacean/effects-specification>

## 决策

1. 新增独立的 `@haiyue/animation-spec`，不依赖 engine、DOM 或 WebGPU。它定义 `haiyue-animation@1.0` 文档、严格 parser、扩展 registry 和 HYA1 二进制 codec。
2. `.hya` 是运行时 IR，不是创作格式。Lottie、Galacean Effects 等转换器位于独立子入口或工具包，只在编辑器导入/构建阶段运行；播放器依赖图中不得出现来源格式 runtime。
3. JSON 作为可读 authoring/debug 表达。交付使用 24-byte header、UTF-8 metadata 和单个对齐 `Float32` track pool，parser 直接创建零拷贝 TypedArray view。
4. 时间统一为秒，坐标统一为左上原点的 `screen-y-down`，转换器负责单位和坐标归一化。runtime 不按来源格式分支。
5. v1 core 只包含节点树、2D transform/opacity、shape2d、sprite2d 和四类基础 track。首个 Haiyue runtime 只实例化 rect/ellipse，规范中已知但 runtime 未实现的 optional 组件可跳过并计数。
6. 扩展 id 使用 `namespace.capability@major`。`extensionsUsed` 是完整能力声明，`extensionsRequired` 表示不能安全降级的能力；缺少 required handler 时在实例化前失败。注册按 handler 身份 token 化注销。
   格式侧 `AnimationExtensionRegistry` 只做不可信数据验证，播放侧 `Animation2DExtensionRegistry` 负责创建、opacity 更新和释放引擎实例；两侧共享 id，但没有包依赖倒置。
7. 转换器返回结构化 diagnostics；普通模式允许显式 warning，strict 模式把任何能力损失变成构建失败。不能静默近似未知语义。
8. parser 将输入视为不可信数据，在分配和建 runtime 对象前执行字节、数量、引用、层级、数值和 binary range 限制。

## 包与运行时边界

- `@haiyue/animation-spec`：格式、parser、binary、extension contract；
- `@haiyue/animation-spec/lottie`：首个离线 adapter；
- `@haiyue/extensions/animation`：依赖 engine 的播放 component/system；
- `createAnimationAssetLoader()`：把 `.hya` 接入 AssetManager 的缓存、取消、进度与 owner 生命周期；
- engine 核心和根入口不增加 Lottie/Galacean 特有 API。

未来 sprite loader、path tessellation、mask、text、particle、audio 等能力先通过扩展验证。只有存在多个独立生产用例、跨 runtime 语义稳定并有尺寸/解析/播放 benchmark 后，才评估进入新 core version。

## 版本与迁移

遵循 ADR 0005。当前无历史兼容负担，不兼容变更直接提升规范版本并迁移仓库 fixtures；不在 parser 中长期堆积旧格式 fallback。首次外部发布前必须重新确认兼容窗口和扩展治理流程。

## 验证

- authoring JSON 校验与 TypedArray 编译测试；
- HYA1 round-trip、range 校验、zero-copy/copy 模式测试；
- required/optional extension 和 token 注销测试；
- Lottie transform/shape/诊断转换测试；
- `Animation2DSystem` 播放、seek、销毁和层级清理测试；
- `animation-spec` example 执行 Lottie → HYA1 → parser → WebGPU 的完整链路。
