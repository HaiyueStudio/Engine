# ADR 0112：临时纹理按使用区间复用

- 状态：Accepted
- 日期：2026-10-01
- 关联：[ADR 0111](0111-framegraph-dependency-culling.md)、[ADR 0097](0097-auxiliary-mrt-and-frame-resource-dependencies.md)

## 决策

在现有资源 owner 下使用私有 TransientTextureAllocator。复用 GPUTexture 对象，不涉及底层 heap 别名或异步多队列。请求提供名称、完整描述符和包含端点的 firstUse/lastUse：同一步读取的输入与写入的输出不能共用物理对象。设备由 allocator 固定；尺寸、层数、维度、格式、采样数、mip、usage 和 viewFormats 精确匹配，深度方向另作兼容条件。不尝试子资源重叠分析或自动扩充 usage。

每次借用在实际命令录制结束后释放逻辑占用。只有同一个 encoder 中已结束使用，或以前的工作已提交到同一设备队列，才允许再次借用；不同未提交 encoder 隔离。首次写入必须 clear 或完整覆盖。GPU 销毁仍等待全部相关提交完成；设备丢失时显式 abandon。闲置代际受清理与容量约束，预算包含活跃、闲置和仍被提交引用的物理纹理。

## 接入与可观察边界

| 路径 | 生命周期与所有权 |
| --- | --- |
| Deferred MRT | 先编译帧计划，再从 gbuffer 使用区间解析物理附件；现有 TransientRenderTargetPool 为 owner。顺序视图可复用兼容附件，最新 G-buffer 持有至下一次 Deferred view 录制，保留诊断 readDebug 的同步编码/提交边界。不同未提交 encoder 不能覆盖它 |
| Deferred AO | 各视图的光照 visibility storage buffer 与参数实例保持独立。r16float visibility 纹理只活到 copyTextureToBuffer；下一次 AO 录制可复用。原有 Slot.textures 仅为最近录制的私有诊断快照，不持有跨视图历史 |
| AO 内部 | raw 在遮蔽/去噪两步使用，denoised 在去噪/upscale 两步使用；两者不相互别名。连续 AO 实例及顺序视图可复用这两张 scratch |
| GaussianBlur | horizontal scratch 活到垂直模糊完成；后续兼容模糊实例可复用。参数 buffer 独立，尺寸切换的旧参数按提交边界退休 |
| 后处理 owner | PostProcessRenderer 持有共享 scratch allocator；准备阶段尚无提交合同的独立调用保持原有自有资源路径。首次受管理录制完成所有权切换并安全退休旧 scratch |

主场景颜色/透射快照、已有双缓冲、TAA 历史、运动历史、外部 RTT、阴影、未知效果资源继续由原 owner 管理。本阶段不把最新可读的 G-buffer 借给后续后处理，也不把 AO visibility buffer 当作可立即覆盖的纹理。因此这是按明确边界落地的复用，不是任意跨阶段别名分配。

## 预算与诊断

Deferred MRT、AO visibility 和 AO scratch 的实际物理分配进入既有 DeferredAllocationBudget，释放时扣除；不增加预算。沿用既有 G-buffer、visibility 与 tile 的单视图 admission 口径；AO scratch 另纳入设备总分配预算。私有池统计区分逻辑请求、物理估算字节、高水位、active/idle/pending 和创建/复用次数；字节是描述符估算，不是驱动显存驻留。

诊断保守模式只禁用不同逻辑请求的共享，用于候选内归因；不是 A0 旧生产版本，不能据此宣称最终端到端性能资格。正式性能测量、图缓存和附件操作优化继续归 G09 后续阶段。

## 验证

单元覆盖描述符不兼容、闭区间端点、缺少提交边界、跨 encoder 隔离、顺序提交、销毁/abandon、预算回滚与尺寸切换。原生 WebGPU 对照开关复用后的像素、实际工作量、四视图物理映射、混合尺寸、最新 G-buffer 读回、稳态零纹理创建及零释放残留；复用既有 G04 与多视图兼容性门禁。
