# G03 点光源热循环优化

状态：当前实现已通过双 GPU 正确性，完整性能复核尚未完成。2026-09-26。

先前自动选择器直接调用 G02 reference resolve；当前改为在 Tiled resolve 中计算完整灯表，同时跳过无收益的 compute。这保留完整贡献与同帧回退，但能使用优化后的点光源函数。G02 原始参考代码与 artifact hash 不变，继续作为数值 oracle。

## 改动

- 每像素只计算一次 F0、roughness⁴ 和视线侧几何遮蔽项，局部灯循环不重复这些不变量。
- 点光函数只接收位置/range、radiance，不读取方向与阴影 identity；方向光及其他全局项仍使用原参考函数。
- 范围外和 N·L≤0 的灯返回零贡献，不减少源表、候选列表或 eligible count。
- compact list 和完整 view list 使用独立循环，避免每盏灯重复选择索引来源。列表顺序不变，溢出不会将前缀和完整列表相加。
- 主动跳过剔除时使用 4-byte 合法空 storage binding，参数声明 storedTiles=0，resolve 直接进入完整表分支；帧图不虚构 tile-list 的 compute producer。该路径没有 compute bind group/scene-frame group 的准备工作。
- Tiled 仅初始化实际使用的两种深度格式 resolve 管线，去掉不再调用的两条 reference resolve 管线；独立 Reference profile 仍照常可用。

ABI、16×16 tile、64 workgroup invocations、128-index 容量、光照公式及公有导出均不改变。浮点运算提取后允许冻结范围内的舍入差异，不宣称位级一致。

## 当前验证

[源码绑定的双 GPU 正确性摘要](g03-point-correctness.json)包含原始路径与 SHA-256。全仓库 typecheck、1,349 项测试、95 个全新示例构建，以及 API/docs/module/responsibility/prepare 检查均通过，日志位于 `artifacts/engine-0.2.1/g03/point-checks/`。

两类 native GPU 均通过 32 个基础/强制溢出比较、47 个边界比较（新增 5 roughness × 3 metallic × compact/full-list 共 30 项）、四视图/resize/compute 跳过与恢复，以及 1025→1024 灯源拒绝和恢复。无 validation error，无资源清理残留。

128 灯高重叠房间的 HDR 最大差值 AMD 0.0078125、Intel 0.03125，逐像素均满足 max(0.002 absolute, 0.002 relative)；LDR 最大差为 1，低于 2 的上限。绝对 HDR 最大值不能单独与 0.002 比较而忽略对应像素亮度。

首个预热 120/保留 300 样本的 AMD 配对：优化 GPU-span P95 14.606874 ms，Reference 17.248394 ms。只是一个诊断配对，不能替代三轮验收。Intel 尝试结束时 CPU_Speed_Limit 从 100 降为 84；虽图像检查通过，该次性能证据无效，原始文件保留。

第一次跳过 compute 的原生尝试发现帧图还声明读取 tile-list；已改为仅有 compute producer 时声明该依赖，随后完整流程通过。失败 capture `tile-render-high-performance-2026-09-26T07-41-24.065Z.json` 仍保留。

当前优化源码使上一版 [三轮性能报告](g03-performance-review.md)、[正确性摘要](g03-current-correctness.json)和 [G02 回归](g03-reference-regression.json)成为历史 checkpoint。不能把旧源码证据冒充当前版本验收。待完成新的全仓库与源码绑定采样后更新审计。
