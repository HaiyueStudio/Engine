# ADR 0009：Device Lost 恢复与资源 Owner Scope

- 状态：Accepted
- 日期：2026-07-13

## 背景

海月在阶段四前只会在 `GPUDevice.lost` 后停止帧循环并输出 warning。GPU 对象由各 renderer 自行创建和销毁，异步资产也没有统一取消信号，因此设备恢复、Scene 切换和 play restart 都无法证明无迟到回写与资源残留。

项目仍处于全新引擎阶段，本决策直接调整 API，不保留旧生命周期语义。

## 决策

1. Engine 使用 `created → initializing → ready → lost → recovering/failed → destroyed`；Scene 使用 `created → active/inactive → destroying → destroyed`。非法状态统一抛出 `EngineError`。
2. `GPUResourceTracker` 记录 owner、label、资源类型和估算字节。owner 分为 engine、scene、system、plugin、asset、frame；scope release 与资源 destroy 均幂等。
3. Engine 在取得真实 `GPUDevice` 后原位 instrument `createBuffer/createTexture/createQuerySet`。资源仍是原生 WebGPU 对象，所有通过 engine device 的分配自动进入审计；RenderIntegration 的 system ownership policy、插件和 AssetManager 会把默认 engine owner 收窄为各自 owner。
4. 可恢复资源实现 `RecoverableGpuResource`，保留 CPU descriptor/source，并注册到 Engine。内置 3D、2D、GUI、实例、文本、阴影及 components 2D 渲染系统均参与恢复。
5. device lost 固定执行八个进度阶段：停止帧、挂起资产、释放旧 GPU 资源、申请 device、重建 render targets、恢复资产、恢复 scene/system/plugin、ready。任一资源无法重建即进入 `failed`，错误 context 包含 owner 与资源 label。
6. Asset job 使用 `queued/loading/parsing/uploading/ready/failed/aborted/released` 状态和 `AbortSignal`。Scene 销毁或 device lost 会终止 owner job；完成结果在 token 失效后只能释放，不能回写 Scene。
7. 插件依赖按拓扑顺序启用、逆拓扑顺序清理；循环依赖、禁用或卸载仍被依赖的插件均失败。安装与启用失败释放 rollback 注册和 plugin GPU owner。
8. play restart、editor viewport teardown 和配置系统重建先销毁 World/System，再销毁 Engine，统一走相同清理顺序。

## 后果

- Editor 可以展示恢复进度与失败原因，不再依赖 console warning。
- Engine/device/Scene/plugin/asset 的重复 destroy、release、abort 不产生额外副作用。
- 直接绕过 HaiyueEngine 自行 `adapter.requestDevice()` 的代码不受 owner 审计保护，因此核心源码门禁禁止这种路径。
- `exactOptionalPropertyTypes` 在 engine 启用，WebGPU descriptor 不再显式写入无意义的 `undefined` 字段。

## 自动约束

- `npm run lifecycle:check`
- `engine/test/lifecycle-stage4.test.mjs`
- `npm run contracts:check`
- `npm run check:fast`
