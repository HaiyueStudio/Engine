# ADR 0114：FrameGraph 按需单帧诊断

- 状态：Accepted
- 日期：2026-10-02
- 前置：[ADR 0111](0111-framegraph-dependency-culling.md)、[ADR 0112](0112-transient-texture-lifetime-reuse.md)、[ADR 0113](0113-framegraph-plan-cache-and-attachment-operations.md)

## 决策

在已有 `@haiyue/engine/experimental/renderer` 增加 `createFrameGraphInspector`、`FrameGraphInspector`、`FrameGraphSnapshot`，与现有帧计划诊断入口同域。stable root、稳定子路径和预算保持不变；renderer 从 56 增至 59 个导出，使用已批准的 9 个储备中的 3 个。兼容 experimental 聚合入口同步增加这 3 个符号（860→863），同样使用既有储备。一般 diagnostics 子路径不承担渲染内部拓扑合同。

每个 Render3DSystem 同时最多一个 inspector。requestCapture 仅武装下一次同步 record；不启动渲染、不插入 pass、不改变导出根、副作用、附件 usage 或资源生命周期。未武装时只有轻量分支判断，不复制图元数据或逐命令代理。嵌套的其他 system 隔离元数据作用域。

捕获范围是所选 system 的 command context。使用只读访问代理包装 encoder/pass，不替换调用方 context.encoder；分配器 afterSubmit 闭包持有相同代理身份，避免提交退休引用失配。元数据引用在 record 结束时转成数字/字符串并释放。snapshot 显式调用才深复制并冻结，导出不持有 GPU 资源或执行回调。clear/dispose 取消未完成捕获，过期提交回调不能覆盖新状态。

## 数据语义

- plans 包含声明节点、真实读写、依赖、活跃/裁剪原因和逻辑生命周期；requirements、view-local、deferred、postprocess 图可能存在包含关系，不能求和当 GPU pass。
- allocations 给出池内 physicalId、完整兼容描述符、估算字节、局部闭区间、复用/拒绝原因；不同批次和图的步骤轴不合并成全局 GPU 时间线。
- pools 只包含捕获帧参与的临时池；record-end 的 physical/active/idle/pending 和累计高水位是分配估算，不是驱动驻留显存。外部附件、持久历史和未接入的资源不假装已有物理映射。
- work 计数实际编码的 render/compute/draw/dispatch/copy/resolve/bundle 命令；失败时状态为 failed，不等同 GPU 成功执行。bundle 内 draw 不可观测时为 null；没有提交钩子时 submissions 为 null。一次提交回调记 1，不代表 engine 全局 queue.submit 数。
- cache 为当前图/批次的累计统计和最近结果；lastInvalidationReason 独立保留最近失效原因，后续 hit 不覆盖它，不推断不存在的 GPU pipeline 缓存指标。
- 每类事件及事件内节点/生命周期/映射最多 256，截断明确标记。snapshot 保留记录帧；下一次 record 不自动更新，显式 clear 清除。
- metadataCopyMs 仅是收集器内部元数据复制时间，排除代理、调用端构造、冻结及 UI 开销；不是完整 CPU 观测成本，也不是正式性能证据。GPU 额外 pass/readback/保留字节为 0。

## 示例和验收

扩展已有 [多光源实验室](../../../examples/deferred-lighting/README.md)，增加效果链、冻结快照、表格/生命周期条、JSON 和逻辑图 PNG 导出。PNG 从 CPU 元数据绘制，不读场景；原有 G-buffer 读回仍需单独选择。退出中止事件/捕获并释放对象 URL，路径/设备切换清除快照。

单元覆盖未武装、冻结、提交、代理身份、失败、截断、嵌套和取消；包消费验证新入口。双设备浏览器验证关闭/开启观察者像素对照、真实裁剪/映射、缓存、移动布局及 pending 捕获退出。实现进度和原始证据在 [阶段五审计](../../../review/engine-0.2.1/g09/diagnostics-audit.md)，完整性能对照与既有稳定性问题仍由 G09 后续阶段验收。
