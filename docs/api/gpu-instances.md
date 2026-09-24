# GPU 实例与模拟 API（experimental）

入口：`@haiyue/engine/experimental/gpu-driven`。这些新增能力处于实验阶段。
公开签名以构建后的 `engine/dist/experimental/gpu-driven.d.ts` 为准。

| 接口 | 契约 |
| --- | --- |
| `GpuComputeProgram` | `initialize()` 异步编译；`createBindGroup()` 绑定属于该初始化代；`dispatch()` 支持 0 次工作组作为无操作；`dispatchIndirect()` 使用 12 字节命令；`destroy()` 使后续操作失效。 |
| `GpuInstanceSource` | 同设备、未映射的 STORAGE 矩阵/颜色/可见 ID；每实例 64/16/4 字节；visibleOffset 遵循 storage alignment。渲染器借用、不写入、不销毁这些缓冲。 |
| `InstancedMesh3DRenderer` | `render()` 的 `externalInstances` 绕过 CPU 实例上传；间接绘制还需 `indirect: true` 与 `externalIndirect`。 |
| `InstancedToonMaterial` | 继承 CPU InstancedMaterial，也兼容外部 GPU 数据；bands 2–8，ambient 0–1；不透明、无阴影；目前采用方向光强度分段和环境亮度下限，不支持点光源或方向光 RGB 染色。 |
| `GpuInstanceLod` | 三档、不透明实例分类器；`encode()` 视锥 + 投影像素尺寸 + 滞回；`source()` 提供指定档 visibility slice；`encodeDrawCount()` 将计数复制到 indexed indirect 的 instanceCount。 |
| `GpuReadbackRing` | 固定 1–16 个槽；请求长度及 source offset 4 字节对齐；要求 `afterSubmit`；忙时返回 null；结果带 requestId、generation、token 和 completed/cancelled/failed。 |
| `inspectGpuSimulationCapabilities` | 校验状态缓冲、工作组、dispatch 和 STORAGE 数量，返回每个实际设备限制；optional features 单独报告，不以设备名称判定。 |

LOD 的包围球必须包含武器、手部、动画和死亡姿态。矩阵/颜色以稳定 ID 索引，可见索引顺序不保证稳定。
源端负责保证可见 ID 小于 capacity、间接 instanceCount 不超过该档容量。`source().count` 是容量上界，LOD 绘制必须配合 GPU 间接计数。
计数命令的 indexCount、firstIndex、baseVertex 由调用者初始化，firstInstance 必须为 0，无需 optional `indirect-first-instance`。

每个 LOD owner 每次提交编码一次；不同视图分别创建 owner。编码后应立即提交，再更新下一帧 uniform；不能在未提交时复写同一 owner 的参数。
`reset()` 清除滞回历史，不是游戏状态重置。设备替换后重建 LOD、实例源、renderer 和 readback；GpuComputeProgram 可重新 initialize，但必须创建新的 bind group。

readback `invalidate()` 使旧结果失效，不抢占在途缓冲；`destroy()` 后已经编码的请求仍须正常提交，以便安全映射/回收。
若整个设备被销毁，底层资源由设备释放；不要继续提交该设备的 command encoder。
将 readback 用于低频统计或检查点；不能因为 ring 忙而跳过游戏逻辑。

使用流程见 [GPU 实例指南](../engine-guide/gpu-instances.md)，决策见 [ADR 0108](../for-ai/adr/0108-gpu-instance-simulation-021.md)。
