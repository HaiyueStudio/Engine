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

`AnimationVectorShapeComponent.feather` 是来源无关的 paint-local Feather contract：`radius` 为两轴非负 canvas unit，`offset` 为可选二维偏移，`inner` 明确区分内外侧，`space` 为 `local|world`。每轴半径 hard ceiling 为 `4096`，且至少一轴必须为正。旧 `innerFeather` 仅为既有 HYA binary 兼容字段；新数据不得同时声明两者。

当前 Lottie 导入闭环保留拓扑稳定 path morph、动态 solid/gradient paint、stroke width/dash offset、空间 Bézier position、animated trim-path/round-corners、mask/matte graph、动画 text document、web font mapping，以及 character/排除空格/word/line、easing、smoothness、确定性 random range selector。type 15 data layer 以 binary resource 和非视觉 node extension 保留。Text Document Expression 的安全子集会在转换期编译为有版本、无后向跳转、受资源预算约束的 HYA IR，覆盖确定性数学、条件、字符串格式化和固定 JSON Data Layer 只读路径；HYA 不保存或执行原始 JavaScript。转换器 diagnostics 继续对 topology change、动画 mask feather、动画 boolean merge、blend/skew、expression selector、超出安全子集的 text expression 与未知 AE effect/plugin 等未覆盖语义给出精确 JSON path。

`convertLottie(source, { fonts })` 的 `fonts` 以 Lottie `fName` 为 key，value 可以是 URI，也可以包含 `uri/family/style/weight/mimeType/integrity`。映射成功时输出 binary font resource；未映射字体产生 `W_LOTTIE_FONT_SUBSTITUTION`，runtime 使用浏览器 fallback metrics 而不会伪装 fidelity 完整。

## 0.2.2 HYA 组合合同（待包集成）

[ADR 0134](../for-ai/adr/0134-hya-production-composition-contract.md) 准入了拟议的 `@haiyue/animation-spec/hya-production`，当前只有源码入口和隔离合同包验证，正式 package exports 尚未加入。不得按下述设计向 0.2.1 包导入。精确 55 个符号见[机器合同](../../config/hya-022-contract.json)，G13 负责正式声明、tarball 和版本集成。

该入口包含组合格式常量、`HyaCompositionError`、`parseHyaComposition`、`encodeHyaComposition`、`negotiateHyaComposition` 及相关类型，并聚焦暴露原 HYLA parser／codec、数据／交互／语义／音频 parser、状态机 v2 parser 和 v1 migration。它不导入 Engine、DOM、GPU、来源转换器或 OpenType，也不提供绘制运行时。

组合信封的 `format` 为 `haiyue-composition`、`version` 为 `1`。根结构为 `{format, version, parts, targets}`；每个 part 显式声明 `{id, extension, required, requires, dependencies, document}`。document 仍经原格式 parser 验证；targets 通过类型化的分段 address 引用原节点、文本、资源或状态输入，不改变原 ID。

```ts
// 拟议 0.2.2 入口；正式消费须等待 G13 的 package admission。
import {parseHyaComposition, negotiateHyaComposition} from '@haiyue/animation-spec/hya-production';

const parsed = parseHyaComposition(bytes); // unknown / JSON 字符串 / UTF-8 buffer
const plan = negotiateHyaComposition(parsed.document, hostCapabilities);
// plan.complete 仅表示声明协商未跳过 part；不是实际功能或画质资格。
```

默认 strict。未知必需 part 始终失败；未知可选 part 仅在显式 `strict:false` 时允许保留原文并跳过，返回 `W_HYA_COMPOSITION_OPTIONAL_SKIPPED`，依赖闭包也随之失效。已知 part 的非法 payload 即使 optional 也失败。`HyaCompositionError` 提供稳定的 `code/path/capability`；包装旧格式失败时保留 `causeCode`。调用方记录这些字段，不解析 message。

总输入上限为 64 MiB、JSON 节点 1,000,000、深度 128、单字符串 UTF-8 4 MiB、part 16、target 100,000、每 part 的 requires 64；调用方只可收紧，原格式内部预算继续生效。整树安全检查先于克隆和 part validator；输出为冻结副本。新信封按确定性 UTF-8 JSON 编码，不替换 HYA container 1／2、HYLA 1.0、HYRG 2.0 或原 sidecar major。

拟议 extensions `/hya-player`、`/hya-text`、`/hya-layout`、`/hya-data`、`/hya-audio` 由 G11 实现，复用原采样／混合、共享布局与 GUI 输入；真实字体／图像／N-slice、资源代次、静默 seek、loop 事件及宿主端口以[执行合同](../../review/engine-0.2.2/hya-contract.md)和[声明草案](../../review/engine-0.2.2/hya-api-draft.d.ts)为准。源码可解析、旧模块测试或隔离类型消费均不代表这些运行时或公开包已合格。
