# `@haiyue/animation-spec`

Haiyue Animation（`.hya`）是面向网页加载、校验和播放的中间动效格式。它不是另一套创作工具文件：Lottie、Galacean Effects 等来源应在构建或导入阶段转换为 `.hya`，播放器只依赖稳定、受限的运行时数据。

## 要求与安装

- Node.js `>=22` 用于 CLI、构建和测试；schema/parser/codec 本身不要求 WebGPU。
- TypeScript 5.2+，`module: "ESNext"`、`moduleResolution: "Bundler"`、`skipLibCheck: false`。
- 只有 Engine runtime preview 需要 release matrix 中的原生 WebGPU 浏览器；本包没有 DOM 或 Engine 依赖。

```sh
npm install @haiyue/animation-spec
```

## 入口选择与最小解析

- `@haiyue/animation-spec`：HYA 类型、严格 parser、binary codec 和状态机数据。
- `@haiyue/animation-spec/lottie`：离线/导入期 Lottie 转换和字体清单。
- `@haiyue/animation-spec/native3d`：`org.haiyue.animation-3d@1` source-neutral 格式 parser/types。
- `hya-convert`：Node.js 22+ CLI。

```ts
import { parseAnimation } from '@haiyue/animation-spec';

const bytes = await fetch('/motion.hya').then(response => {
  if (!response.ok) throw new Error(`HYA request failed: ${response.status}`);
  return response.arrayBuffer();
});
const animation = parseAnimation(bytes);
console.log(animation.duration, animation.nodes.length);
```

`parseAnimation()` 和 codec 不持有 Worker、DOM 或 GPU 资源，不需要 `dispose()`；丢弃返回对象即可。Engine runtime 中创建的 asset handle、animation instance、media/Worker 和 scene owner 由对应宿主显式释放。格式错误使用 `AnimationFormatError` 的稳定 code/path；Lottie fidelity 问题读取 converter diagnostics，并在交付流水线使用 `strict: true`。

## 能力样例浏览器

仓库内置 `animation-spec/index.html` 能力浏览器，并保留
`animation-spec/viewer.html` 作为可直接运行的稳定入口。manifest 与二进制 fixture
位于 `animation-spec/samples`，每个文件只声明一个唯一的主能力。页面支持
内置样例切换、远程 HYA/JSON URL、本地文件与拖放导入、时间轴、JSON 查看，
以及运行时和 WebGPU diagnostic。

```sh
npm run samples:generate -w ./animation-spec
EXAMPLE_FILTER=hya-samples npm run build -w ./examples
npm run serve:examples:lan
```

然后访问本地示例服务的 `/animation-spec/`。

## 包边界

- `@haiyue/animation-spec`：零引擎依赖的类型、严格 parser、`.hya` codec 和扩展注册表。
- `@haiyue/animation-spec/lottie`：可选 Lottie 转换器；不会进入基础 parser bundle。
- `@haiyue/extensions/animation`：Haiyue 运行时组件和系统。
- `hya-convert`：离线转换 CLI。

`@haiyue/extensions` 是首发仓库应用使用的 private workspace，不是 `@haiyue/animation-spec` 的公共 npm 依赖，也不属于 0.1 的公共 npm package 集。公共 consumer 可以独立完成 schema、parse、codec 和转换；播放宿主需自行实现或随 Haiyue 静态应用消费 runtime。

```ts
import { encodeAnimationBinary, parseAnimation } from '@haiyue/animation-spec';
import { convertLottieDocument } from '@haiyue/animation-spec/lottie';

const document = convertLottieDocument(lottieJson);
const deliveryBuffer = encodeAnimationBinary(document);
const animation = parseAnimation(deliveryBuffer); // keyframe tracks are zero-copy Float32Array views
```

```ts
import { createAnimationAssetLoader } from '@haiyue/extensions/animation';

engine.assetManager!.registerLoader(createAnimationAssetLoader());
const handle = await engine.assetManager!.loadUrl('motion.hya');
// handle.value is ParsedAnimation; release the handle with the scene/resource owner.
```

```ts
import { Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Particle2DRenderSystem, Particle2DSystem } from '@haiyue/engine';

scene.addSystem(new Animation2DSystem({ assetManager: engine.assetManager! }), false);
scene.addSystem(new Particle2DSystem(), false);
scene.addSystem(new Animation2DRenderSystem(engine, cameraEntity, {
  loadOp: 'clear',
  maxMaskTargets: 16,
}));
scene.addSystem(new Particle2DRenderSystem(engine, cameraEntity, { loadOp: 'load' }));
```

```sh
npm run build -w ./animation-spec
node animation-spec/bin/hya-convert.mjs input-lottie.json output.hya
```

JSON 用于调试和工具交换，`.hya` 用于网页交付。完整约束见 [SPECIFICATION.md](./SPECIFICATION.md)，机器可读约束见 [schema/animation.schema.json](./schema/animation.schema.json)。运行时 parser 仍是安全边界的最终校验器。

仓库中的 [`examples/animation-spec`](../examples/animation-spec/) 是可交互转换工作台：可以读取允许 CORS 的 Lottie URL 或直接粘贴 JSON，查看 diagnostics/HYA JSON、下载 `.hya`，并在 WebGPU 预览中播放、逐帧移动和拖动时间轴。

真实素材质量与性能基线见 [`corpus/`](./corpus/) 和 [`examples/hya-corpus-dashboard`](../examples/hya-corpus-dashboard/)：固定许可明确的 Lottie/AE 参考帧，统一采集 fidelity、raw/gzip size、source-to-runtime parse、warm-adapter first-frame，以及按源 JSON path 建立的 feature 失败归因。运行 `npm run hya:dashboard` 会验证素材哈希、重新转换并通过 Chrome WebGPU 更新两处同源报告。

## v1 能力

| 能力 | 规范 | 首版 Haiyue runtime | Lottie converter |
| --- | --- | --- | --- |
| 节点树 / 2D transform / opacity | 是 | 是 | 是 |
| rect / ellipse | 是 | 是 | 是 |
| image sprite / UV rect / sRGB | 是 | 是，复用 AssetManager | 是 |
| M/L/Q/C vector path / fill rule | 是 | 是，自适应细分与 geometry cache | 静态 path；动画统一 cubic topology、方向与起点，顶点变化用无损曲线细分归一 |
| vector paint / stroke | 内建 `org.haiyue.vector-shape@1` | solid/linear/radial gradient、动态 color/opacity/width、dash | 保留同一 shape stack 的多 paint、fill rule、gradient 与 dash |
| ordered mask stack | 单节点最多 8 层，可嵌套 | add/subtract/intersect/difference、alpha/luma/inverted、feather/animated expansion | 是；超 8 层分解为有序 coverage node，动画 feather 仍精确诊断 |
| track matte | 是 | 支持嵌套 composite graph | alpha/luma 及 inverted，可与 mask stack 组合 |
| canvas text | 是 | 动态 document、web font、tracking、确定性 grapheme shaping、字符 animator/range selector | 静态与动画 text document；character/排除空格/word/line、easing、smoothness、确定性 random selector；expression 精确诊断 |
| ordered visual effects | 是，最多 8 项 | tint/fill/opacity/color-matrix/blur/drop-shadow，单视图复用一对 ping-pong target | 静态与动画参数；未知 AE effect/plugin 不静默近似 |
| deterministic particle2d | 是 | 是，引擎原生 SoA simulation + WebGPU instancing | 不适用 |
| timeline audio | 是 | 是，HTML media 与 composition time 同步 | audio layer |
| step / linear / cubic easing | 是 | 是 | 是 |
| spatial Bézier motion | position track `spatialTangents` | 普通 timeline 与状态机 mixer 共用 | 保留 Lottie `to/ti` 与 temporal easing |
| path modifiers | `vector-shape@1` ordered modifiers | animated trim-path、round-corners | simultaneous/individual trim 与 group scope |
| nested precomp / time stretch | 节点树与普通 track | 是 | 是；precomp 与普通 layer 共用局部 timeline，保留父级 transform、opacity、in/out/start/stretch |
| precomp time remap | 烘焙为普通 track 时间 | 无来源格式分支 | 单调 scalar keyframe 支持；静态/非单调形式精确诊断 |

转换器必须返回结构化 diagnostics。默认模式允许能力降级，`strict` 模式用于流水线阻止任何有损转换。

转换器同时识别新版 Lottie 的显式 `a: 1` 和旧 Bodymovin 仅以 `k[].t/s/e` 表达的关键帧。后者不再被误判为静态数组。position 的空间 Bézier `to/ti` 与 temporal easing 分开编码；trim-path、round-corners 以有序、来源无关的 path modifier 执行。path morph 会统一为 cubic command topology，并在顶点数变化时用 de Casteljau 曲线细分保持关键帧几何；Merge Paths mode 1 的多个动画 operand 会按素材帧率 bake 为同一 compound morph。文字 document、font mapping、tracking，以及包含 character/排除空格/word/line、easing、smoothness、稳定随机种子的 range selector 都保存在 HYA ABI 中。type 15 data layer 作为 `binary` resource 和非视觉 `org.haiyue.data-layer@1` 节点扩展保留。动画 mask feather、动画 boolean Merge Paths、非 normal layer blend、skew、radial highlight、repeater、expression selector、text expression 与未知 effect/plugin 仍返回带精确 JSON path 的 diagnostics，不会静默丢失或执行源脚本。

`org.haiyue.vector-shape@1` 是来源无关的内建视觉组件，不是 Lottie 私有运行时分支。它把 path topology、可选 morph track、solid/gradient fill 或 stroke paint，以及按数组顺序执行的 trim/round modifier 编进 HYA Float32 pool；paint opacity 独立于颜色 alpha，避免动画 opacity 被重复相乘。Lottie animated path 坐标会量化到 1/64 canvas unit，最大源误差为 1/128 unit；转换器同时设置 `morphRelative`，让 morph track 保存相对初始 values 的 delta，运行时采样后再还原绝对坐标，从而避免重复坐标破坏 gzip 交付效率。旧 HYA v1/v2 容器和既有普通 `path2d`、`org.haiyue.vector-stroke@1`、`org.haiyue.vector-path-morph@1` 数据继续可读。

`convertLottie()` 的 `fonts` 字段和独立的 `inspectLottieFonts()` 会列出每个 authored font 的使用次数、替代 family、WOFF2 URI、integrity hash 与可选实测 metrics。缺少映射仍输出 `W_LOTTIE_FONT_SUBSTITUTION`；工具不能猜测或静默使用平台字体。动画转换工作台会把这份清单与普通 diagnostics 一起展示。

扩展分为两个相互独立的安装点：`AnimationExtensionRegistry` 校验不可信格式数据，`Animation2DExtensionRegistry` 创建和释放引擎视觉实例。两者使用同一个 versioned id，但工具链无需依赖 WebGPU runtime，runtime 也无需依赖来源格式转换器。

Haiyue 运行时由 `Animation2DSystem` 负责时间轴、文字 atlas/web font、音频同步和异步资源生命周期，由独立的 `Animation2DRenderSystem` 负责有序 sprite/path/text 绘制、mask/matte 与效果栈。效果管线在单个 view 内只复用一对全视口 RGBA ping-pong target，并在覆盖下一项前提交当前结果，显存不会随 effect entity 数增长；若 renderer 被错误安装到共享外部 pass，效果会计入 `droppedEffectCount` 而不会尝试嵌套 pass。粒子仿真与绘制属于引擎通用能力，分别安装 `Particle2DSystem` 和 `Particle2DRenderSystem`；格式 runtime 只负责实例化 emitter、时间轴 seek 和资源句柄。

## 单素材状态机

内建扩展 `org.haiyue.animation-state-machine@1` 可以在一个 `.hya` 内声明多个命名时间区间以及状态机。区间引用同一 composition 的 track/node/resource 表，不复制素材或 GPU 资源；运行时把区间适配为 2D clip，再通过共享 mixer 将最终 pose 写回同一棵 HYA 节点树。

```json
{
  "extensionsUsed": ["org.haiyue.animation-state-machine@1"],
  "extensionsRequired": ["org.haiyue.animation-state-machine@1"],
  "extensions": {
    "org.haiyue.animation-state-machine@1": {
      "clips": [
        { "id": "idle", "start": 0, "duration": 1 },
        { "id": "run", "start": 1, "duration": 0.8 }
      ],
      "stateMachine": {
        "format": "haiyue-animation-state-machine@1",
        "id": "character",
        "name": "Character",
        "parameters": [{ "name": "moving", "type": "boolean", "defaultValue": false }],
        "layers": [{
          "id": "base", "name": "Base", "initialStateId": "idle",
          "states": [
            { "id": "idle", "name": "Idle", "motion": { "kind": "clip", "clipId": "idle" }, "loop": "repeat" },
            { "id": "run", "name": "Run", "motion": { "kind": "clip", "clipId": "run" }, "loop": "repeat" }
          ],
          "transitions": [{
            "id": "move", "from": "idle", "to": "run", "duration": 0.2,
            "conditions": [{ "parameter": "moving", "operator": "is-true" }]
          }]
        }]
      }
    }
  }
}
```

```ts
import {
  Animation2DStateMachineComponent,
  Animation2DStateMachineSystem,
} from '@haiyue/extensions/hya-state-machine';

scene.addSystem(new Animation2DStateMachineSystem({ assetManager: engine.assetManager! }), false);
const character = new Animation2DStateMachineComponent(hya, { autoplay: true });
entity.addComponent(character);
character.setBoolean('moving', true); // Idle -> Run，按 transition.duration cross-fade
```

参数支持 float、integer、boolean 和一次性 trigger；state 支持 clip、1D/2D Blend Tree，layer 支持 weight、override/additive 和 binding mask。区间裁剪会保留 step/linear/cubic-bezier 曲线。当前 pose mixer 不会静默丢弃 timeline audio、particle、animated path morph 或自定义带时间副作用的组件；这些内容用于状态 clip 时会在实例化前给出精确诊断。

当前 `particle2d` 使用独立 render pass，因此不参与动画视觉的精确层间排序和 mask/matte；需要这种语义时应在后续引入统一的 2D render graph item 协议。浏览器音频受 autoplay policy 约束，用户手势前的 `play()` 失败会保持可重试，不会中断动画帧。

## License

[MIT](./LICENSE)

Repository：[HypnosNova/HaiYue / animation-spec](https://github.com/HypnosNova/HaiYue/tree/main/animation-spec)。规范见 [SPECIFICATION.md](./SPECIFICATION.md)，首发支持边界见 [known limitations](https://github.com/HypnosNova/HaiYue/blob/main/docs/engine-guide/known-limitations.md)。
