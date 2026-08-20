# 已知限制与支持边界

本页记录 0.1 首发刻意保留的产品上限。浏览器和设备集合以 [`config/release-matrix.json`](../../config/release-matrix.json) 为唯一来源；API 入口以包 `exports` 和构建声明为准。

## 渲染与浏览器

- Engine、Scene Editor、AnimationEditor 预览、导出 Runtime 和 Voxel Editor 都是 WebGPU-only，没有 WebGL2 renderer fallback。Shader Language 的 GLSL ES 300 输出只证明编译后端可行性，不代表运行时兼容。
- 0.1 的稳定支持范围是 Windows 10 22H2+ Chrome/Edge，并要求真实 NVIDIA GeForce 或 AMD Radeon RX 独显；Windows 集显未列入首发兼容性承诺。Chrome/macOS 与 Safari/macOS 当前属于 extended，不应描述为 0.1 稳定支持平台。
- `batched` 是普通产品默认 profile。`gpu-driven` 和 `diagnostic` 需要协商 optional feature；不满足时只能按 capability report 明确降级，不能伪装成原 profile。
- 首发不承诺固定 FPS 或某类设备的性能等级。性能结论必须来自当前 clean revision、登记真机和完整 workload；压力测试预算不等于产品帧率承诺。
- PBR/Blinn/实例化 forward lighting 每个视图最多消费 8 盏有效灯。PBR 最多为前 3 盏有效投影方向光生成 shadow map；后续灯仍可参与照明，但不会被描述为拥有阴影。
- 当前没有 Forward+、clustered lighting、shadow atlas 或 cascaded shadow maps。Toon 路径只消费一张方向光阴影，不能用 PBR 的三层容量推断 Toon 行为。

## NavMesh

- 稳定 NavMesh 面向 Y-up 地形和 RTS/普通地面移动，每个 X/Z 栅格只保存最高表面。
- 洞穴、重叠楼层、桥下可行走区域、任意重力方向和分层多边形 NavMesh 不在 0.1 支持范围。
- NavMesh 负责全局路径和查询期动态圆形障碍，不替代连续碰撞检测、角色刚体或群体局部避让。
- Scene Editor 当前保存地形和受控实体，不持久化 NavMesh 派生缓存、动态障碍状态或 DOM 控制器；游戏启动代码负责构建、安装和释放。

## HYA、Lottie 与动画

- HYA core 1.0 是 `screen-y-down` 的 2D runtime 格式。原生 3D 使用 required `org.haiyue.animation-3d@1` 扩展；AnimationEditor 将 2D 与 3D 保持为不同工程族。
- 不支持同一 HYA composition 或 AnimationEditor 工程内的原生 mixed 2D/3D。引擎可以在普通场景组合 2D HUD 与 3D 世界，但这不是 HYA mixed composition。
- Lottie 转换不是完整 Lottie fidelity 承诺。expression、未知插件/effect 以及其他未覆盖语义必须产生带 code 和 JSON path 的 diagnostic；strict 模式用于拒绝任何有损转换。
- 状态机对 transform/opacity/visibility 等 pose channel 提供混合；audio、particle、animated path morph 或未知时间副作用必须遵守 capability registry，不能静默退化成静态内容。
- SpriteSheet rotated/trimmed atlas、任意 audio cross-fade 和若干高级组合 authoring 仍会被 AnimationEditor 精确拒绝，具体以 [`CAPABILITY_MATRIX.md`](../../../Editor/AnimationEditor/CAPABILITY_MATRIX.md) 为准。

## API 与应用分发

- 首发公共 npm 包为 `@haiyue/engine`、`@haiyue/animation-spec` 和 `@haiyue/extensions`。Extensions 的业务 runtime subpath 已按 ADR 0070/0071 转正；根入口以及 `/experimental/gltf-worker`、`/experimental/spine-worker` 仍为 experimental。`ui`、Shader Language 和三个编辑器仍是 private workspace。
- Engine 所有非 `experimental` export subpath 为 stable；`/experimental` 及其 focused subpath 可以在 minor 版本重构。包中未由 `exports` 暴露的文件是 private。
- Scene Editor、AnimationEditor 和 Voxel PWA 是静态应用。Voxel Electron 仅为 unsigned preview，不应被描述为已签名、已公证或商店可分发版本。

发现行为与本页不一致时，按[故障排查](./troubleshooting.md)收集环境和 diagnostic，再对照 [API Reference](../api/README.md) 与 manifest，而不是从源码目录推断支持状态。
