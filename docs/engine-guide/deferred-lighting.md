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

## FrameGraph 诊断

示例底部「FrameGraph」区域先选择效果链，再点击「捕获下一帧」：

1. 选择 GTAO + 双模糊，查看 Deferred/AO/后处理的逻辑资源、物理 ID 与复用原因。
2. 选择灰度 → 模糊 → AO 独立输出，查看不再被读取的颜色步骤裁剪；AO 所需辅助输入继续保留。
3. 查看局部图的读写依赖、生命周期条和缓存命中。改变效果/路径/窗口尺寸后重新捕获，比较结构和资源；关闭效果回到基础场景。
4. 导出 JSON 保存整份快照；导出图 PNG 保存所选逻辑图。两种导出都只使用冻结元数据，不读取场景 GPU 内容。

```ts
import { createFrameGraphInspector } from '@haiyue/engine/experimental/renderer';
const inspector = createFrameGraphInspector(scene.render3DSystem!);
inspector.requestCapture(); // 下一次 system.record() 收集；不会启动 engine
// 在该帧完成后显式读取；未捕获时为 null。
const snapshot = inspector.snapshot();
// 退出时注销，不影响 system 的 GPU 所有权。
inspector.dispose();
```

捕获后的数据保持冻结，动画、灯数和相机改变不会自动刷新。路径/设备切换清除快照。图层级可能重叠；实际编码的 pass/draw/dispatch/submit 在摘要独立显示。区间只在所属图/分配批次内比较；池高水位仅覆盖参与捕获的临时池，不代表全部显存。一次捕获会增加 CPU 开销，不作为正式计时；完整字段和不可观测值见 [API 合同](../api/framegraph-inspector.md)。
