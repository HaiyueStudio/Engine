# 0026：World 逻辑帧与 FrameData 阶段修订分离

- 状态：Accepted
- 日期：2026-07-18

## 背景

`World.update()` 在组件和系统更新前调用 `FrameData.begin()`，`RenderPipeline.execute()` 又在录制前调用一次。第二次 begin 能让更新阶段已经解析、随后又被修改的 Transform 在渲染前重新计算，但也让一个逻辑帧产生多个 `frameId`；安装多个 runtime integration 时，`frameId` 还会随 integration 数量变化。Camera、Scene environment、Scene frame uniform 和 SpatialIndex 因而无法判断其失效键表示逻辑帧还是某次渲染准备阶段。

## 决策

1. `FrameData.frameId` 只表示 `World.update()` 的逻辑帧。一次 update 无论安装多少 runtime integration 都只递增一次。
2. `FrameData.phaseRevision` 表示 phase-local 数据的失效 epoch。开始逻辑帧和系统更新结束后的阶段边界分别推进一次；推进 phase 不改变 `frameId`。
3. `TransformStore` 的访问缓存只以 phase revision 为键，不再暴露含义模糊的 `frameId`/`beginFrame` 别名。
4. `WorldFrameToken` 是无分配的 opaque number，只能由当前 `FrameData + World + phaseRevision` 消费。`World.update()` 把系统更新后的同一个 token 传给全部 `WorldRuntimeIntegration`。
5. `RenderIntegration` 把 token 传给 `RenderPipeline`。Pipeline 消费 token 时只附加当前 engine，不开启逻辑帧或推进 phase；脱离 World 调度的独立 `RenderPipeline.execute()` 仍自行开启一个逻辑帧。
6. Camera2D/3D、Scene render environment、Scene frame uniform 和共享 SpatialIndex 的 phase-local 缓存以 `phaseRevision` 失效，同时在快照中保留 `frameId` 用于诊断和跨系统关联。
7. token 与 frame snapshot 都是 borrowed experimental 数据，调用方不得跨阶段保存。无效或过期 token 以 `E_ENGINE_INVALID_STATE` 失败，不静默开启另一帧。

## 验证

- 两个以上 runtime integration 在同一次 `World.update()` 中观察到相同的 `frameId` 与 `phaseRevision`。
- 更新系统先解析相机 Transform、随后修改 Transform 时，render integration 在相同 `frameId`、新的 `phaseRevision` 中得到更新后的相机与 Scene frame uniform。
- 独立 Pipeline 仍能在没有 World token 时创建自己的逻辑帧。
- Camera/Transform 对象继续跨帧复用，不因 epoch 分离重新引入稳态分配。

## 后果

逻辑帧统计不再受渲染 integration 数量影响，phase-local 缓存拥有统一失效语义。以后增加 physics、late-update 或多视图准备阶段时可以显式推进 phase，而不伪造新的逻辑帧。新增 token 和 phase API 只进入 `@haiyue/engine/experimental`，普通 Scene 用户仍只使用既有黄金路径。
