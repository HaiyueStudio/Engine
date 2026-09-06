# ADR 0098：GPU-driven 间接绘制命令复用

- 状态：Accepted
- 日期：2026-09-06
- 关联：[ADR 0096](./0096-scene-linear-hdr-output.md)、[ADR 0097](./0097-auxiliary-mrt-and-frame-resource-dependencies.md)

## 问题

GPU-driven profile 已由 compute 生成和剔除逐对象间接参数，但内置 renderer 的 renderBatch 仍逐对象查找资源、绑定管线/缓冲并编码 indirect draw。直接实例批次依赖连续 object slot，不能直接合并存在剔除空洞或对象槽位重排的 GPU 命令。

## 决策

Basic、PBR、Blinn-Phong、Depth、Normal 和 Toon 的已准备 opaque 批次按连续 geometry/material 区间建立 Render Bundle。每个区间绑定一次共享状态，首次录制其所有 indexed/non-indexed indirect draw；后续帧通过 executeBundles 重用命令。命令仍引用当前 view-ring 的间接参数缓冲，每个 draw 独立读取 instanceCount 和 firstInstance，保留 GPU 剔除空洞、非连续对象槽、对象变换、裁剪及变形数据更新。

缓存只消费 prepareObjects/flushUploads 完成后的资源。没有预先准备的直接 renderer 调用保留原有逐对象路径。直接实例 profile、透明排序、Basic 透明深度预通道、透射捕获和自定义 material registration 不改变。没有 shader ABI、公开 profile 参数或 GPU buffer 格式变更。

缓存键比较实际管线、所有绑定组、复制后的 SceneFrame 动态偏移、各 vertex/index buffer、索引格式、间接区间长度及附件布局。相机、材质、morph/skin、剪裁和 indirect 参数的内容更新本身不使命令失效；资源对象替换、附件/MSAA 或管线变化则重录。不同 renderer、间接缓冲和起始偏移不共享命令。每个间接缓冲最多保留 256 个区间，避免排序布局变化积累无限历史。

每个 bundle 完整绑定它消费的状态，因为 [WebGPU executeBundles](https://www.w3.org/TR/webgpu/#dom-gpurenderpassencoder-executebundles) 会清空管线、绑定组与 vertex/index 状态。后续 renderer 仍负责自己的绑定。缓存使用弱 GPUBuffer 键；view-ring 退休后不额外保留它，renderer 清理管线/销毁时清空缓存。Bundle 没有显式销毁方法，底层 GPU 资源的安全退休仍由原 owner 负责，不能因缓存失效提前销毁。

## 指标与边界

内部缓存统计 builds、hits、executions、encodedDraws、reusedDraws 和 evictions。GPUResourceTracker 在 bundle 完成时记录其 draw/pipeline 数量，在每次执行时累加，防止把少编码误报成少 GPU 绘制。基准审计独立记录 bundle 编码、执行、普通 draw 编码，并继续检查逐 pass 分类与总数相等。共享 mock 的 capability contract 升为 v2，增加 render-bundle。

本次减少 CPU 命令编码与重复状态绑定，GPU draw 数仍是逐对象级别。对象收集、准备、参数上传、区间扫描仍有 O(N) 工作；大量独立几何/材质、频繁资源重建或透明排序的收益较小。缓存冷启动需要录制，不能声称 CPU 零分配、零逐对象工作或已实现 GPU 可见实例压缩。

## 验证

结构测试检查缓存命中、动态偏移快照、实际资源替换、indexed/non-indexed offset、有界历史、双视图预热、统计和销毁。真实 GPU 对比原有逐对象间接提交，覆盖六类 renderer、双相机、剔除空洞、morph/skin、对象裁剪、纹理替换/alpha mask、透明叠加、删除/扩容与混合 MSAA/reverse-Z 视图。性能分开记录 CPU 录制/提交、GPU render-pass timestamp、队列等待、上传、分配、GPU draws/passes 与资源残留。

具体环境、诊断测量和未通过门禁见[评审记录](../../../review/gpu-driven-indirect-bundles-2026-09-06.md)。
