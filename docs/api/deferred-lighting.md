# Deferred Lighting（experimental）

入口：`@haiyue/engine/experimental/renderer`。不提供 stable 兼容性承诺。

| 符号 / 方法 | 合同 |
| --- | --- |
| `createDeferredLightingProfile(system, engine, options?)` | 异步安装已有 Render3DSystem 的 Deferred 后端；Scene/system 拥有 GPU 生命周期 |
| `DeferredLightingProfileOptions.mode` | `reference` / `tiled`，默认 tiled |
| `signal` | 初始化取消；已取消的信号拒绝执行 |
| `forceCulling` | 仅诊断时强制分块，默认 false |
| `profile.snapshot()` | 复制的实际策略/回退原因、提交点光源数、分配/上传/pass/tile 统计；不会读取 GPU |
| `profile.readDebug(channel)` | 异步复制最新视图图像；过期/并发/资源不可用返回 null；设备错误拒绝 Promise |
| `profile.dispose()` | 幂等；移除当前 handle 的后端，不能释放后来安装的 profile |
| `DeferredLightingDebugChannel` | base-color、normal、metallic、roughness、emissive、occlusion、depth、tiles |
| `DeferredLightingDebugImage` | width/height、RGBA8 pixels；depth 通道另含原始浮点 depth；tiles 另含 fullListTiles/maxLights |

非法 mode/channel 拒绝为 RangeError。能力错误来自已有 Deferred 能力检查；渲染时 fallback 以 snapshot 的 effective/completeCoverage/reason 为准。Scene/system 销毁或后端替换后，旧 handle 不再 active。readDebug 只对最新记录视图有定义，多视图诊断需由调用方明确记录顺序。

[完整示例与操作](../engine-guide/deferred-lighting.md) · [ADR 0110](../for-ai/adr/0110-deferred-example-profile.md)
