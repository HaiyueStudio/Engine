# ADR 0070：首批 Extensions 转正与只读 Diagnostics 门面

- 状态：Accepted
- 日期：2026-08-13
- 影响范围：`engine`、`extensions`、public package release contract、API baseline

## 背景

ADR 0068 在首发候选阶段把 `@haiyue/extensions` 排除在公共 npm 包之外。随后对 experiment 能力的逐项审计确认：来源无关 Animation3D、glTF runtime，以及二者 adapter 已具有独立 facade、类型测试、真实示例和资源生命周期闭环；同时用户明确要求执行第一批转正。Engine diagnostics 也已有成熟采集实现，但把 tracker/recorder 直接转正会冻结写协议、资源句柄、owner 标识和堆栈格式。

## 决策

1. `@haiyue/extensions@0.1.0` 成为 public npm package；这项决定替代 ADR 0068 中“extensions 保持 private”的发布范围结论。
2. 第一批 stable entrypoints 只有：
   - `@haiyue/extensions/animation3d`
   - `@haiyue/extensions/gltf`
   - `@haiyue/extensions/gltf-animation3d`
3. Extensions 其他既有 export 为仓库工具和应用继续随包分发，但在 0.1 中统一标记为 experimental。`experimental/gltf-worker` 明确承载 worker transport、source builder、parsed asset 与 geometry preparation 等底层协议。
4. stable glTF 声明不得依赖 `@haiyue/engine/experimental`，也不导出 worker client/source builder 或 parsed-asset preparation API。
5. Engine 新增 stable `@haiyue/engine/diagnostics`，只导出 `getEngineDiagnosticsSnapshot(engine)` 与只读结构类型。返回值必须深冻结，且不得包含 tracker/recorder 写方法、GPU resource handle、owner identity、label 或 creation stack。
6. `@haiyue/engine/experimental/diagnostics` 继续拥有完整 instrumentation、resource ownership 与 mutation API；稳定门面不是其兼容聚合。
7. API baseline、release manifest、真实 tarball consumer 和 package budgets 在同一变更中重冻。0.1 仍不承诺 WebGL fallback。

## 后果

- 普通使用者可以通过 package subpath 获得完整 glTF + Animation3D 路径，不必依赖仓库源码 alias。
- 内部诊断实现仍可演进；稳定调用方只依赖聚合快照语义。
- Spine、Tilemap、Animation2D、Canvas Text、Tween、Grid 与 HYA 2D state machine 尚未转正，后续必须分别通过依赖、声明、性能和产品证据审计。
