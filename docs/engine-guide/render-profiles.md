# Render profiles 与能力协商

普通项目只选择一个声明式 profile：

| Profile | 用途 | 可选设备特性 | 明确 fallback |
| --- | --- | --- | --- |
| `simple` | 最小 GPU/内存占用、兼容性定位 | 无 | 无 |
| `batched` | 默认 3D 产品配置，CPU 视锥裁剪与批处理 | 无 | 无 |
| `gpu-driven` | GPU 命令与裁剪 | `indirect-first-instance` | `batched` |
| `diagnostic` | GPU-driven 加时间戳和裁剪回读 | 上项加 `timestamp-query` | `gpu-driven` 或 `batched` |

```ts
const engine = new HaiyueEngine({ canvas, renderProfile: 'gpu-driven' });
await engine.init();
console.table(engine.capabilities?.report.decisions);
```

`report` 同时给出 `requestedProfile`、`enabledProfile`、`degraded`，每个 decision 都包含 `requested`、`enabled`、`fallback` 和 `reason`。功能不会静默关闭。运行时可用 `scene.render3DSystem.setRenderProfile(name)` 切换逻辑策略；设备特性只在创建/恢复 device 时重新协商。

逐项布尔 override 不属于 stable API。确需实验性算法研究时在 `@haiyue/engine/experimental` 建立有测试的高级入口。

`gpu-driven` 会复用内置不透明材质的兼容绘制命令区间，减少稳定帧的 CPU 编码和状态绑定；对象移动、裁剪和骨骼动画仍读取更新后的 GPU 数据。共享几何与材质越多，收益通常越明显。对象准备与上传仍有成本，GPU 绘制数量不会因此自动减少，透明对象仍遵循原排序规则。实现及指标边界见 [ADR 0098](../for-ai/adr/0098-gpu-driven-indirect-bundle-submission.md)。

这些 profile 的内置照明都会按视图选择灯光：跳过无效灯和影响范围不与视锥相交的点光，优先保留亮度与影响范围更大的光源，并减少临界候选之间的来回切换。多相机分别选择，阴影方向光保留一致的阴影层对应关系。场景可以放置更多灯，但同一视图仍有固定照明容量，切换 `gpu-driven` 不会自动启用 clustered 或消除灯光容量限制。调试多灯画面时，应先检查影响范围和实际落选情况；实现与诊断边界见 [ADR 0099](../for-ai/adr/0099-view-light-selection-before-clustering.md)。
