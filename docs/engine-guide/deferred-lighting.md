# Deferred 多光源示例与实验入口

从 [多光源实验室](../../examples/deferred-lighting/index.html) 开始，完整操作见[示例说明](../../examples/deferred-lighting/README.md)。0.2.1 的实现和入口仍为 experimental；示例正常运行不表示所有设备达到 G05 的帧率目标。

## 使用

```ts
import { HaiyueEngine } from '@haiyue/engine';
import { createDeferredLightingProfile } from '@haiyue/engine/experimental/renderer';

const engine = new HaiyueEngine({ canvas, msaaSamples: 1, renderProfile: 'diagnostic', diagnostics: { enabled: true } });
await engine.init();
const scene = engine.createScene({ render3D: { renderProfile: 'batched' }, render2D: false, gui: false });
// 添加标准 PBR 不透明/透明物体和 PointLight。
const profile = await createDeferredLightingProfile(scene.render3DSystem!, engine, { mode: 'tiled' });
engine.switchScene(scene);
engine.run();
// 主动读取 CPU 诊断；不会触发 GPU 读回。
console.log(profile.snapshot());
// 可选：显式异步获取最新视图 G-buffer，不用于正式计时。
const image = await profile.readDebug('normal');
// 返回 Forward；旧 handle 不会销毁后来安装的 profile。
profile.dispose();
// 退出时释放场景及全部 engine 资源。
engine.destroy();
```

`mode: 'reference'` 使用全灯参考，`mode: 'tiled'` 使用保守分块剔除与同帧完整灯表回退。`signal` 可取消初始化。仅当需要实际 tile 调试列表时启用 `forceCulling: true`。普通场景不应为此强制计算低收益分块。

`renderProfile: 'diagnostic'` 在 Engine 初始化时申请可选 timestamp；Scene 使用 batched 保持这组对照的基础绘制路径。没有 timestamp 的设备仍可渲染，GPU 读数必须显示不可用。

## 能力与限制

- 标准 PBR 不透明、alpha-mask 走 G-buffer，透明 PBR 使用完整灯表 Forward。示例包含透明球。
- 不兼容材质/helper/MSAA 等组合应检查 `effective / completeCoverage / reason`；不得把有容量限制的 Forward 回退写成完整多灯。
- 本示例使用 sampleCount=1。局部点光源没有阴影；方向光阴影和其他材质/效果的支持边界见 [ADR 0109](../for-ai/adr/0109-deferred-lighting-021-contract.md)。
- `readDebug()` 返回主动复制的数据，内部 staging buffer 在成功/失败后释放；同一 handle 并发读取返回 null。调用方切换 channel、相机或 profile 时还需使用自己的 generation 防止旧图覆盖新图。
- 热力图粉色表示索引溢出或未存储块的完整灯表回退，不表示丢灯。world-position 视图使用浮点设备深度重建，仅覆盖不透明 G-buffer。
- Snapshot 内存是 Deferred 跟踪分配估算；GPU pass 合计、CPU record、帧间隔是不同计时口径，不相加，不替代 P95。

API 准入说明见 [G06 评审](../../review/engine-0.2.1/g06-example-api-review.md)。跨引擎比较与设备分档另立目标，不借示例重写现有性能结论。
