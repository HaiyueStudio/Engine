# glTF 模型、动画播放与切换

海月通过 `@haiyue/extensions/gltf` 加载 `.gltf` 和 `.glb`。普通游戏场景推荐使用 `createGltfPlugin()` 与 `GltfModelComponent`：插件负责加载系统、Scene 资产 owner、取消和释放；应用只负责选择并采样动画。

完整查看器位于 [`examples/gltf-viewer`](../../examples/gltf-viewer)；使用来源无关 Animation3D Mixer 完成 Idle → Run 混合的聚焦示例位于 [`examples/gltf-animation3d-crossfade`](../../examples/gltf-animation3d-crossfade)。

## 准备模型文件

`.glb` 把 JSON、buffer 和图片放在一个文件中，部署最简单。`.gltf` 可以引用外部 `.bin` 和图片，这些 URI 会相对 `.gltf` 文件 URL 解析，因此部署时必须保留目录关系：

```text
public/
└── assets/
    └── hero/
        ├── hero.gltf
        ├── hero.bin
        └── textures/
            ├── base-color.png
            └── normal.png
```

开发时应通过 HTTP dev server 访问资产，不要直接打开 `file://` 页面。跨域模型、buffer、图片和 Draco decoder 都需要正确的 CORS 响应头。

## 加载并显示模型

下面是推荐的 Scene plugin 写法：

```ts
import {
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  HaiyueEngine,
} from '@haiyue/engine';
import {
  createGltfPlugin,
  GltfModelComponent,
} from '@haiyue/extensions/gltf';

const engine = new HaiyueEngine({
  canvas: '#canvas',
  renderProfile: 'batched',
});
await engine.init();

const scene = engine.createScene({
  name: 'glTF animation',
  render3D: true,
});
scene.installPlugin(createGltfPlugin());

const sun = new Entity('Sun');
sun.addComponent(new DirectionalLight({
  direction: [-0.5, -1, -0.35],
  intensity: 2.5,
  castShadow: true,
}));
scene.add(sun);

const environment = new Entity('Environment');
environment.addComponent(new EnvironmentLight({ intensity: 0.8 }));
scene.add(environment);

const model = new GltfModelComponent({
  src: '/assets/hero/hero.glb',
  autoLoad: true,
  clearPrevious: true,
});
const actor = new Entity('Hero');
actor.addComponent(new CartesianTransform3D({
  position: [0, 0, 0],
  scale: [1, 1, 1],
}));
actor.addComponent(model);
scene.add(actor);

engine.switchScene(scene);
engine.run();
```

`GltfModelSystem` 在 Scene 更新期间异步加载模型。运行时字段的含义如下：

| 字段 | 用途 |
| --- | --- |
| `status` | `'idle' \| 'loading' \| 'loaded' \| 'error'` |
| `error` | 加载失败时的错误文本 |
| `runtimeRoot` | 插入 `actor` 下方的 glTF 节点树 |
| `runtimeAnimations` | 轻量动画摘要：名称、时长、channel 数量 |
| `runtimeAnimationClips` | 可以传给 `applyGltfAnimationClip()` 的运行时 clip |
| `runtimeCompatibilityReport` | 扩展、纹理、bounds 和降级报告 |

只有 `status === 'loaded'` 后才能读取运行时动画。不要在创建 `GltfModelComponent` 后立即访问 clip。

如果只需要调整整个模型的位置、旋转或缩放，应修改承载组件的 `actor` transform；加载出的 glTF 节点会作为它的子树继承该变换。

## 播放第一个动画

`applyGltfAnimationClip(clip, time)` 的 `time` 单位是秒；`engine` 的 update event 中 `delta` 单位是毫秒，因此必须除以 `1000`：

```ts
import { applyGltfAnimationClip } from '@haiyue/extensions/gltf';
import type { GltfAnimationClip } from '@haiyue/extensions/gltf';

let activeClip: GltfAnimationClip | null = null;
let animationTime = 0;
let playing = false;
let started = false;

engine.on('update', ({ detail: { delta } }) => {
  if (!started && model.status === 'loaded') {
    started = true;
    activeClip = model.runtimeAnimationClips[0] ?? null;
    animationTime = 0;
    playing = activeClip !== null;
  }

  if (!playing || !activeClip) return;
  animationTime += delta / 1000;
  applyGltfAnimationClip(activeClip, animationTime);
});
```

`applyGltfAnimationClip()` 会把时间按 clip duration 取模，所以这段代码默认循环播放，也支持负时间采样。它会更新节点 TRS、morph weights 和 skin joint matrices。

动画应在 `update` 中采样，使新 pose 能被同一帧的 Scene 更新与渲染看到。不要同时在 `update` 和 `after-update` 重复采样。

## 完整播放控制与动画切换

下面的控制层提供播放、暂停、恢复、跳转、按名称切换和非循环播放：

```ts
import {
  applyGltfAnimationClip,
  type GltfAnimationClip,
} from '@haiyue/extensions/gltf';

let activeClip: GltfAnimationClip | null = null;
let animationTime = 0;
let playing = false;
let looping = true;

function requireClip(name: string): GltfAnimationClip {
  if (model.status !== 'loaded') {
    throw new Error(`Model is not loaded; current status is ${model.status}.`);
  }
  const clip = model.runtimeAnimationClips.find(candidate => candidate.name === name);
  if (!clip) {
    const available = model.runtimeAnimationClips.map(candidate => candidate.name).join(', ');
    throw new Error(`Unknown animation "${name}". Available animations: ${available || '(none)'}.`);
  }
  return clip;
}

function sampleAnimation(): void {
  const clip = activeClip;
  if (!clip || clip.duration <= 0) return;

  // applyGltfAnimationClip(duration) 会回到 0，因此非循环动画使用略小于 duration 的末帧时间。
  const endTime = Math.max(0, clip.duration - 1e-6);
  const sampleTime = looping ? animationTime : Math.min(animationTime, endTime);
  applyGltfAnimationClip(clip, sampleTime);
}

function playAnimation(
  name: string,
  options: { restart?: boolean; loop?: boolean } = {},
): void {
  const nextClip = requireClip(name);
  const changed = nextClip !== activeClip;
  activeClip = nextClip;
  looping = options.loop ?? true;
  if (changed || options.restart !== false) animationTime = 0;
  playing = true;
  sampleAnimation(); // 切换时立即显示新动画的第一帧。
}

function pauseAnimation(): void {
  playing = false;
}

function resumeAnimation(): void {
  if (activeClip) playing = true;
}

function seekAnimation(seconds: number): void {
  animationTime = Math.max(0, seconds);
  sampleAnimation();
}

function stopAnimation(): void {
  playing = false;
  animationTime = 0;
  sampleAnimation();
}

engine.on('update', ({ detail: { delta } }) => {
  const clip = activeClip;
  if (!playing || !clip) return;

  animationTime += delta / 1000;
  if (!looping && animationTime >= clip.duration) {
    animationTime = clip.duration;
    playing = false;
  }
  sampleAnimation();
});
```

加载完成后，可以通过按钮或角色状态机切换动画：

```ts
function listAnimations(): string[] {
  return model.runtimeAnimationClips.map(clip => clip.name);
}

// 这些名称来自 DCC 工具导出的 glTF animation.name。
playAnimation('Idle');

runButton.addEventListener('click', () => playAnimation('Run'));
attackButton.addEventListener('click', () => playAnimation('Attack', { loop: false }));
pauseButton.addEventListener('click', pauseAnimation);
```

建议在 Blender、Maya 等工具中为动画设置唯一且稳定的名称。glTF 本身不保证动画名称唯一；`find()` 在重名时会选择第一项。需要严格控制时，可以改为按 `runtimeAnimationClips[index]` 选择。

## 等待加载并自动播放

当前 `GltfModelComponent` 通过 `status` 暴露加载状态，没有单独的 loaded event。可以在 update 中只处理一次：

```ts
let handledSourceKey = '';

engine.on('update', () => {
  if (
    model.status !== 'loaded'
    || !model.runtimeSourceKey
    || model.runtimeSourceKey === handledSourceKey
  ) {
    return;
  }

  handledSourceKey = model.runtimeSourceKey;
  console.table(model.runtimeAnimations);

  const idle = model.runtimeAnimationClips.find(clip => clip.name === 'Idle');
  const fallback = model.runtimeAnimationClips[0];
  const initial = idle ?? fallback;
  if (initial) playAnimation(initial.name);
});
```

`runtimeSourceKey` 包含 `src` 和 glTF scene index。修改任一项并完成新加载后，它都会变化，因此这段代码也能处理模型热切换。

主动切换模型时，应先清除应用持有的旧 clip：

```ts
function changeModel(src: string): void {
  activeClip = null;
  animationTime = 0;
  playing = false;
  handledSourceKey = '';
  model.src = src;
}
```

插件会在新资源加载成功后替换 `runtimeRoot`。`clearPrevious: true` 会释放旧模型；Scene 被销毁时，pending load、纹理、buffer、object URL 和 asset handle 也会一起清理。

## Draco 压缩模型

包含 `KHR_draco_mesh_compression` 的模型需要 Draco decoder。默认 loader 会尝试从页面相对路径加载 decoder；正式项目更适合显式配置自己的静态资源 URL：

```ts
scene.installPlugin(createGltfPlugin({
  system: {
    dracoDecoderConfig: {
      scriptUrl: '/vendor/draco/draco_decoder_gltf_nodejs.js',
    },
  },
}));
```

decoder script 及其加载的 wasm 文件都必须能从部署环境访问。可运行配置参考 `examples/gltf-viewer`。

## 低层手动加载

只有在调用方确实要自行管理模型生命周期时，才直接使用 `loadGltfModel()`：

```ts
import {
  applyGltfAnimationClip,
  disposeGltfModel,
  loadGltfModel,
} from '@haiyue/extensions/gltf';

const loaded = await loadGltfModel('/assets/prop.glb');
scene.add(loaded.root);

const clip = loaded.animationClips[0];
if (clip) applyGltfAnimationClip(clip, 0);

// 不再使用时必须先从场景移除，再释放 loader 创建的资源。
scene.remove(loaded.root);
disposeGltfModel(loaded);
```

不要让 `GltfModelComponent` 与低层 loader 同时拥有同一个模型。手动路径必须负责错误处理、取消、Scene 切换和 `disposeGltfModel()`；普通产品代码应优先使用 plugin recipe。

## Animation3D 稳定适配与平滑切换

glTF → Animation3D adapter 从 `@haiyue/extensions/gltf-animation3d` 稳定子路径导入。它把 glTF animation 转换为来源无关的 `Animation3DClip`，并使用 `@haiyue/extensions/animation3d` 的 `Animation3DMixer` 与调用方可见的 `Animation3DPoseBuffer`；没有复制第二套 sampler 或 mixer。`STEP`、`LINEAR`、`CUBICSPLINE`（含 in/value/out tangent）会完整进入 Animation3D track。

adapter 的运行时把一个 pose 原子应用到根 TRS、skinning joint 和 GPU morph，因此 cross-fade 不会出现“骨架已经切换、morph 仍停留在旧动作”的半帧状态：

```ts
import { createGltfAnimation3DRuntime } from '@haiyue/extensions/gltf-animation3d';

const runtime = createGltfAnimation3DRuntime(loaded, {
  clipIdPrefix: 'hero',
});

const idle = runtime.mixer.createAction(runtime.clips[idleIndex], {
  id: 'Idle',
  loop: 'repeat',
});
const run = runtime.mixer.createAction(runtime.clips[runIndex], {
  id: 'Run',
  loop: 'once',
  clampWhenFinished: true,
});

idle.play();
run.crossFadeFrom(idle, 0.25);

engine.on('update', ({ detail: { delta } }) => {
  runtime.update(delta / 1000);
});
```

`@haiyue/extensions/animation3d` 与 `@haiyue/extensions/gltf-animation3d` 都受 package exports、类型白名单和 API baseline 管理。不要从 `extensions/src/**` 或 runtime 深层路径导入。glTF adapter 不公开 resolver、pose-applier 或 binding endpoint；需要诊断时读取 runtime 的 `bindingCount`、`targetCount` 和 `state`。

`GltfAnimation3DRuntime` 不拥有 `LoadedGltfModel`。资源替换或销毁时先销毁 runtime，再调用 `disposeGltfModel()`；若 model root 或 Scene 先被销毁，挂在 root 上的 owner component 也会释放 action、binding 与 pose target。传入的 `AbortSignal` 被触发时同样会清空这些状态。

## 当前动画边界

- 稳定的 `@haiyue/extensions/gltf` 路径支持 translation、rotation、scale、morph weights 与 skinning；`applyGltfAnimationClip()` 仍保留且没有 breaking change。
- `applyGltfAnimationClip()` 是 legacy 单 clip sampler，不是 Mixer。同一帧依次调用多个 clip 时，后调用者覆盖相同 target/path；它的 `CUBICSPLINE` 兼容路径仍只读取 value，不计算 tangent。
- Animation3D adapter 提供 action weight、cross-fade、来源无关 clip 和完整 `CUBICSPLINE`，并已经闭环根 TRS、skinning 与 GPU morph。
- 两条路径不能同时驱动同一个模型。使用 Animation3D runtime 后，不要再对该模型调用 `applyGltfAnimationClip()`。
- 角色状态机、layer、mask 与 additive 能力位于稳定 Animation3D facade；glTF adapter 只负责 clip/binding/pose 转换，不再实现一套状态机。
- root motion、retargeting、IK 与动画压缩仍不属于 glTF adapter。

材质、纹理、扩展支持和动态 bounds 说明见 [PBR、阴影与环境光](./pbr-rendering.md)；取消、worker 与资源释放语义见 [资产生命周期](./asset-lifecycle.md)。
