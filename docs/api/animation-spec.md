# `@haiyue/animation-spec`

Animation Spec 定义面向 Web 加载与解析优化的可扩展动效中间格式，以及 Lottie 等外部格式到该格式的转换入口。格式版本、解析结果和扩展能力以 [`animation-spec/package.json`](../../animation-spec/package.json) 的 exports 与构建声明为准。

引擎粒子系统属于 engine；Animation Spec 只描述和驱动相应能力，不复制粒子渲染实现。

精确类型签名以构建后的 `animation-spec/dist/*.d.ts` 为准。

## 稳定入口与错误

- `@haiyue/animation-spec`：`parseAnimation`、HYA binary encode/decode、扩展 registry 和状态机数据 contract。
- `@haiyue/animation-spec/lottie`：`convertLottie`、`convertLottieDocument` 和 `inspectLottieFonts`；返回 diagnostics，不执行来源脚本。
- `@haiyue/animation-spec/native3d`：`parseNative3DAnimation`、`parseNative3DAnimationPayload`、`createNative3DAnimationExtensionHandler` 和对应类型。
- `@haiyue/animation-spec/conversion`：来源无关的离线转换 session、采样、诊断和原子输出 host contract。
- `@haiyue/animation-spec/live2d/clip-baked`：注入已获许可 Cubism evaluator 的构建期 clip-baked adapter；不包含 Core、Framework 或页面播放器。
- `hya-convert`：Node.js 22+ CLI，不是 browser export。

HYA parse/codec 失败抛出 `AnimationFormatError`；调用方应记录 code/path，而不是按英文 message 分支。Lottie 转换的 fidelity 问题位于返回结果 `diagnostics`，每项包含 severity、code、path 和 message；`strict: true` 将 warning 作为交付阻断。Native 3D required extension 未注册或 payload 非法时必须在创建 runtime owner 前失败。

格式版本和 2D/3D 范围见 [`SPECIFICATION.md`](../../animation-spec/SPECIFICATION.md)与[已知限制](../engine-guide/known-limitations.md)，不要从 TypeScript package version 推断 HYA container/project 版本。

当前 Lottie 导入闭环保留拓扑稳定 path morph、动态 solid/gradient paint、stroke width/dash offset、空间 Bézier position、animated trim-path/round-corners、mask/matte graph、动画 text document、web font mapping，以及 character/排除空格/word/line、easing、smoothness、确定性 random range selector。type 15 data layer 以 binary resource 和非视觉 node extension 保留。Text Document Expression 的安全子集会在转换期编译为有版本、无后向跳转、受资源预算约束的 HYA IR，覆盖确定性数学、条件、字符串格式化和固定 JSON Data Layer 只读路径；HYA 不保存或执行原始 JavaScript。转换器 diagnostics 继续对 topology change、动画 mask feather、动画 boolean merge、blend/skew、expression selector、超出安全子集的 text expression 与未知 AE effect/plugin 等未覆盖语义给出精确 JSON path。

`convertLottie(source, { fonts })` 的 `fonts` 以 Lottie `fName` 为 key，value 可以是 URI，也可以包含 `uri/family/style/weight/mimeType/integrity`。映射成功时输出 binary font resource；未映射字体产生 `W_LOTTIE_FONT_SUBSTITUTION`，runtime 使用浏览器 fallback metrics 而不会伪装 fidelity 完整。
