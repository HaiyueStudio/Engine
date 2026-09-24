# 在 GPU 上模拟和绘制大批实例

这是实验性低层路径，适合 ParallelLegion 一类共享程序的大批士兵。
完整可运行代码在 [gpu-instances 示例](../../examples/gpu-instances/main.ts)，由 [manifest](../../examples/manifest.json) 登记。

```bash
npm run build:engine
npm run build:target -- example:gpu-instances
node scripts/verify-gpu-instances-021.mjs
```

开发预览服务器中打开 `examples/gpu-instances/`。示例用 GPU 更新 10,000 个实例，按投影尺寸选择三档几何，并用三条间接绘制命令显示。
动画帧不回读实例状态；启动自检会读回计数与 ID，以检查分类完整性。

## 初始化

1. 创建 HaiyueEngine 并 `await engine.init()`，按实际 `device.limits` 调用 `inspectGpuSimulationCapabilities()`。
2. 应用拥有 STORAGE 状态缓冲与输出矩阵/颜色。仅材质需要 CPU 对象，使用 `new InstancedToonMaterial(1)` 即可，不需要分配全军的 CPU 矩阵。
3. 创建 GpuComputeProgram 并等待 initialize；准备 bind group。渲染器通过现有 PipelineWarmupPlan 预热，LOD owner 在加载阶段创建。
4. 为三个 LOD 创建几何和 indexed indirect 命令。近档圆角方块、中档低面数圆角方块、远档普通方块；身体/武器可复用同一份可见 ID，各自使用几何对应的命令。

## 每帧

顺序是：固定逻辑 tick → 写 GPU 展示姿态 → LOD encode → encodeDrawCount → beginRenderPass → renderer.render → end → submit。
先完成 compute 再进入 render pass，同一个 command encoder 保证先后依赖。不要在 dispatch 内 await、编译或 readback。

游戏可以有多次逻辑 tick，但 LOD 与插值姿态通常只需每个展示帧更新一次。逻辑 tick 必须保持独立于画面帧率；加速播放应改变单位时间执行的 tick 数。
Toon 的档位不会增加游戏程序 tick，死亡动画也不应推迟已完成的逻辑判定。

每条间接绘制绑定 `externalInstances: lod.source(level, transforms, colors)`、`indirect: true` 和相应的 externalIndirect。
不要直接用 source.count 绘制整个档：它是容量，实际人数在 GPU 命令中。

## 读回、设备恢复与手机

- GpuReadbackRing 只用于按需统计、胜负摘要或检查点；调用方的 afterSubmit 必须在 queue.submit 之后执行。取消时使用 generation/token，忽略过期关卡的结果。
- 换关卡或销毁时，完成已编码请求的提交，再销毁资源；映射中的缓冲由 ring 延迟回收。例子在设备丢失时停止并提示重新初始化。
- 游戏通过既有 [设备恢复接口](device-recovery.md) 注册资源重建。重新上传程序/地图，从最近检查点确定性重放；未保留的 GPU 游戏状态无法自动恢复。
- 同屏人数、分辨率、DPR、LOD 阈值和动画细节应分别控制；仅降低 LOD 无法降低模拟复杂度。GPU VM 的 O(N²) 全军扫描需要游戏改成网格索引、分阶段意图/冲突结算。
- 当前示例与桌面 GPU 正确性测试不构成手机性能承诺。发布前仍需 iOS/Android 实机、热稳定、挂起恢复及长时间 mapAsync 压力测试。

参数和所有权限制见 [API](../api/gpu-instances.md)。
