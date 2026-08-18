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
