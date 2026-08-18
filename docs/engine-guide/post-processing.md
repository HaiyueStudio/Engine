# 使用后期处理效果

后期处理在 3D 场景完成后读取场景颜色，并按顺序执行一个或多个全屏 `PostProcessPass`。普通项目通过 `PostProcessRenderFeature` 把效果链挂到场景的 `Render3DSystem`；中间纹理、窗口尺寸变化和最终输出由引擎管理，不需要直接创建 `PostProcessRenderer`。

## 接入一个最小效果链

下面在已有 3D 场景中启用 FXAA。应先创建 pass 和 feature，再将 feature 加入场景：

```ts
import { HaiyueEngine } from '@haiyue/engine';
import {
  FxaaPass,
  PostProcessRenderFeature,
} from '@haiyue/engine/postprocess';

const engine = new HaiyueEngine({ canvas: '#canvas' });
await engine.init();

const scene = engine.createScene({
  name: 'post-processing',
  render3D: true,
});

if (!scene.render3DSystem) {
  throw new Error('Post-processing requires a 3D render system.');
}

const fxaa = new FxaaPass();
const postProcess = new PostProcessRenderFeature(
  scene.render3DSystem,
  [fxaa],
);
scene.addSystem(postProcess);

// 产品场景可在显示前预编译当前效果链的 pipeline。
const warmup = await scene.warmupPipelines();
if (warmup.status !== 'completed') {
  throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
}

engine.switchScene(scene);
engine.run();
```

`PostProcessRenderFeature` 应当与它接收的 `Render3DSystem` 属于同一个场景。创建 feature 会要求该 3D renderer 使用独立 render pass，以便场景颜色可以被后续 pass 采样。

## 组合和切换效果

构造函数和 `setPasses()` 接收的顺序就是执行顺序。下面先模糊场景，再在模糊结果上执行 FXAA：

```ts
import {
  FxaaPass,
  GaussianBlurPass,
} from '@haiyue/engine/postprocess';

const blur = new GaussianBlurPass({ radius: 5, sigma: 2.5 });
const fxaa = new FxaaPass();

postProcess.setPasses([blur, fxaa]);
```

运行时可以替换整个效果链：

```ts
function setPostProcessing(mode: 'off' | 'fxaa' | 'blurred') {
  if (mode === 'off') {
    postProcess.setPasses([]);
  } else if (mode === 'fxaa') {
    postProcess.setPasses([fxaa]);
  } else {
    postProcess.setPasses([blur, fxaa]);
  }
}
```

空数组会关闭后期处理。被移出效果链的 pass 会释放它持有的 GPU 资源；以后重新加入时，引擎会再次准备它。因此 `setPasses()` 适合响应画质档位或用户设置变化，不要每帧重复调用。运行中加入新的 pass 后，如需避免第一次显示时同步编译，可再次调用 `scene.warmupPipelines()`。

## 内置 Pass

所有内置效果都从 `@haiyue/engine/postprocess` 导入：

| Pass | 用途 | 引擎额外准备的场景数据 |
| --- | --- | --- |
| `FxaaPass` | 低成本的空间抗锯齿 | 无 |
| `GaussianBlurPass` | 可配置半径和 sigma 的水平/垂直高斯模糊 | 无 |
| `GrayscalePass` | 灰度转换 | 无 |
| `SobelPass` | 亮度梯度边缘或边缘叠加 | 无 |
| `OutlinePass` | 为带 `OutlineTarget` 的对象绘制可见/遮挡轮廓 | 选择对象的轮廓 mask |
| `TaaPass` | 带投影抖动、重投影和历史拒绝的时域抗锯齿 | 线性深度和每个 view 的历史 |
| `MotionBlurPass` | 相机、刚体、morph 和蒙皮动画的运动模糊 | motion vectors 和上一帧变换 |
| `CustomPass` | 使用自定义 WGSL fragment shader 的全屏效果 | 由自定义 pass 决定 |

只有当前效果链声明需要时，引擎才会创建深度、motion 或 outline 等辅助纹理。每个全屏 pass 仍会增加 GPU 工作；`GaussianBlurPass` 内部包含水平和垂直两个 render pass。

多数效果参数可以直接在运行时修改。例如：

```ts
import { SobelPass } from '@haiyue/engine/postprocess';

const sobel = new SobelPass({
  edgeColor: [0.2, 0.85, 1],
  strength: 1.8,
  threshold: 0.06,
  blend: 0.8,
  edgeOnly: false,
});

postProcess.setPasses([sobel, fxaa]);

// UI slider 的回调中可以直接更新公开参数。
sobel.strength = 2.4;
sobel.edgeOnly = true;
```

## 为选中对象添加轮廓

`OutlinePass` 不会自动给所有物体描边。把 stable 的 `OutlineTarget` 组件添加到需要高亮的 entity：

```ts
import { OutlineTarget } from '@haiyue/engine/components';
import {
  FxaaPass,
  OutlinePass,
} from '@haiyue/engine/postprocess';

selectedEntity.addComponent(new OutlineTarget());

const outline = new OutlinePass({
  visibleEdgeColor: [0.2, 0.9, 1, 1],
  hiddenEdgeColor: [0.08, 0.03, 0.02, 1],
  edgeStrength: 3,
  edgeThickness: 1,
  edgeGlow: 0,
  blendMode: 'add',
});

postProcess.setPasses([outline, fxaa]);
```

轮廓效果依赖额外的选择 mask 渲染。如果 pass 已启用但画面中没有轮廓，先确认目标 entity 已经包含 `OutlineTarget`，并且它拥有可被 3D renderer 绘制的几何和材质。

## 正确处理 TAA 和 Motion Blur 的历史

时域效果依赖连续帧。相机切镜、时间轴跳转、角色瞬移或一次性大幅修改 transform 后，应显式让历史失效：

```ts
import {
  MotionBlurPass,
  TaaPass,
} from '@haiyue/engine/postprocess';

const taa = new TaaPass({
  feedback: 0.9,
  depthThreshold: 0.002,
  sharpness: 0.15,
  jitterScale: 1,
});

const motionBlur = new MotionBlurPass({
  shutterAngle: 180,
  intensity: 2,
  sampleCount: 12,
  maxBlurPixels: 32,
  reconstruction: 'tile-neighbor-max',
  displayMode: 'blur', // 也可使用 'split' 或 'velocity' 做诊断
});

postProcess.setPasses([taa]);

function onCameraCut() {
  taa.resetHistory();
  motionBlur.resetHistory();
}
```

`TaaPass` 为每个 view 分别维护历史；调整 `jitterScale` 或重新启用 TAA 时也应调用 `resetHistory()`。`MotionBlurPass` 的第一帧只建立上一帧状态，只有相机或对象在连续帧之间发生运动时才会产生模糊。`shutterAngle` 只描述帧周期内的曝光比例，`intensity` 是独立的美术增益；提高 `sampleCount` 只改善采样平滑度，不会放大模糊。默认 `centered` 模式沿当前像素 velocity 采样；`tile-neighbor-max` 额外生成 8×8 tile-max 和 3×3 neighbor-max 速度层，让运动表面稳定地贡献到轮廓外侧，最终跨度仍受 `maxBlurPixels` 限制。`split` 显示原图/结果分屏，`velocity` 显示方向和长度热图。

如果产品只需要一种抗锯齿，通常在 TAA 与 FXAA 之间选择一种。组合多个效果时，把依赖原始几何时序信息的 pass 放在风格化、强模糊或边缘处理之前，再根据实际画面验证顺序。

## 编写简单的自定义效果

`CustomPass` 自动提供全屏三角形、`VertexOutput`，以及下面两个 group 0 binding：

```wgsl
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
```

调用方只需要提供 `fs_main`。下面的 pass 分离红蓝通道：

```ts
import { CustomPass } from '@haiyue/engine/postprocess';

const chromaticAberration = new CustomPass({
  label: 'ChromaticAberration',
  fragmentCode: /* wgsl */ `
    @fragment
    fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
      let size = vec2<f32>(textureDimensions(srcTex, 0));
      let offset = vec2<f32>(3.0 / size.x, 0.0);
      let r = textureSample(srcTex, srcSampler, in.uv + offset).r;
      let g = textureSample(srcTex, srcSampler, in.uv).g;
      let b = textureSample(srcTex, srcSampler, in.uv - offset).b;
      return vec4<f32>(r, g, b, 1.0);
    }
  `,
});

postProcess.setPasses([chromaticAberration, fxaa]);
```

自定义 uniform、texture 或 sampler 使用 `CustomPass` 的 `extraBindings` 与 `extraEntries` 放入 group 1 及后续 bind group。需要线性深度、normal、motion 或自定义多阶段资源时，应继承 `PostProcessPass` 实现独立 pass，而不是从 renderer 内部读取私有纹理。

## 生命周期与常见问题

- 把 `PostProcessRenderFeature` 加到 scene，而不是只创建实例；未执行 `scene.addSystem(postProcess)` 时效果链不会参与渲染。
- 在 feature 创建前确保 scene 启用了 `render3D`，并使用该 scene 自己的 `render3DSystem`。
- 不要同时手工改写 `scene.render3DSystem.passes`；运行时统一通过 `postProcess.setPasses()` 更新顺序。
- Canvas 或 render target 尺寸变化时，引擎会调用 pass 的 `resize()` 并重建所需中间纹理。
- scene 或 render system 销毁时会销毁已准备的 pass 及其中间纹理，不需要应用直接销毁内置 renderer。
- 后期处理需要拥有完整的场景 pass。高级自定义 pipeline 不应把启用后期处理的 `Render3DSystem` 放进一个外部已打开的共享 render pass。

## 可运行示例

- [`examples/postprocess`](../../examples/postprocess/)：FXAA、Gaussian Blur、Grayscale、Outline 与 `CustomPass` 的运行时切换。
- [`examples/outline-postprocess`](../../examples/outline-postprocess/)：选择对象轮廓和 FXAA 组合。
- [`examples/sobel-postprocess`](../../examples/sobel-postprocess/)：Sobel 参数调节。
- [`examples/taa-postprocess`](../../examples/taa-postprocess/)：TAA 历史、投影抖动和运行时控制。
- [`examples/motion-blur`](../../examples/motion-blur/)：相机、刚体与动画对象的 motion vectors。
- [`examples/toon-pencil-sketch`](../../examples/toon-pencil-sketch/)：Outline、FXAA 与 Toon 风格的组合。
