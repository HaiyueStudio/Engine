# G09 阶段四：安全附件操作与计划缓存

日期：2026-10-02。实现合同见 [ADR 0113](../../../docs/for-ai/adr/0113-framegraph-plan-cache-and-attachment-operations.md)。本阶段不改变版本、公共 API、Shader 或预算，不代表完整 G09/G05 性能资格通过。

## 实现范围

- FramePlan 缓存验证后的依赖、活跃节点、执行顺序和资源区间；Deferred 与 view/scene-global owner 分开管理。
- PostProcessGraph 缓存逐效果颜色/辅助需求与副作用推导；命中重新绑定当前效果实例，AO displayMode 切换重新编译。
- TransientTextureAllocator 缓存逻辑区间着色方案；每帧重新选择物理资源并检查 pending/submitted 状态，不缓存纹理或历史绑定。
- 各缓存最多 16 项，LRU 淘汰，设备代际和 owner 销毁清理；暴露私有命中/失效统计和消融开关。执行中的 FramePlan 明确拒绝自身重入/变更，异常后可继续使用。
- visible outline 使用已证明禁止深度写入的 pipeline，切换为 depthReadOnly；辅助深度的 clear/discard 通过明确消费者合同选择。后者是原有行为，不算本阶段新增收益。

### 必须保留的操作

G-buffer、AO 中间结果、Gaussian scratch 的内容有实际读者，继续 store。外部目标的深度供后续叠加系统使用，保留；局部 viewport/scissor 不等于全覆盖。MSAA resolve、透射 copy、时间历史以及 Deferred 透明/扩展材质顺序不变。没有额外符合条件的 pass 合并或 resolve/copy 省略候选，因此不宣称 pass 数下降或已测得 GPU 带宽收益。

### 原生检查发现的生命周期缺陷

第一轮新增混合尺寸四视图描边对照报告 `Destroyed texture OutlinePass.edgeTex used in a submit`，旧 Outline.resize 会销毁同一 encoder 前一个视图还在引用的纹理。修复为提交完成后退休旧纹理，同时为不同尺寸保留独立的 blur 参数 buffer，避免后视图的 texel size 覆盖前视图。销毁同样采用提交边界；增加定向回归。第一轮失败证据和日志保留，不通过删去混合尺寸用例规避。

## 验证范围

原生矩阵沿用既有 G04 效果/AO 语义/输出、多视图生命周期、辅助语义、复用对照，并加入阶段四开关消融。新对照包含 Forward 单视图、reference/Tiled 同尺寸四视图、Tiled 混合尺寸四视图、相机移动、AO/模糊/描边链，检查当前帧回调、缓存命中、物理资源、只读深度操作、实际 pass 和像素。

### 双 GPU 专项对照

[专项原始证据](../../../artifacts/engine-0.2.1/g09/cache-native-2026-10-02T00-24-27.000Z.json)中，AMD RDNA 1 与 Intel Gen 9 的五组对照均通过，包含 Forward 1×/4× MSAA、reference 四视图、Tiled 同/混合尺寸四视图。所有像素最大差为 0，最新 G-buffer 一致，验证错误和释放残留为 0。

Forward 实际 pass 为 22→22，Deferred 四视图为 96→96；同一复用模式下物理临时纹理字节不变。每视图选择一次只读场景深度。测量帧中 view/post/Deferred 及 AO/MRT 分配缓存均命中、没有新增 miss；整个五帧记录中四视图 view 和 Deferred 计划各为 4 次冷 miss + 16 次 hit。更换相机位置后仍与禁用缓存的当前帧输出一致。

这不是“全部后处理稳态零分配”的证据：混合尺寸 Outline 仍在 resize 时创建并延迟退休自身纹理和参数，未纳入阶段三临时纹理池。本阶段修复安全性，不把这部分创建抹掉。

### CPU 粒度诊断

[原始数据](../../../artifacts/engine-0.2.1/g09/cache-cpu-2026-10-02T00-25-27.645Z.json)与[可重现脚本](../../../artifacts/engine-0.2.1/g09/cache-cpu-diagnostic.mjs)记录三个交错轮次，每轮 200 帧预热、4,000 次完整 declare/compile-or-lookup/execute，以每批 20 次的均值取分位数。仅为 Node 上的合成计划微基准，不是 Engine 整帧性能人口。

| 计划规模 | 关闭缓存 P50，三轮范围 | 开启缓存 P50，三轮范围 |
| --- | ---: | ---: |
| 8 节点 | 0.0238–0.0264 ms | 0.0099–0.0103 ms |
| 16 节点 | 0.0388–0.0425 ms | 0.0180–0.0187 ms |

这支持缓存结构编译的粒度选择，但不能外推整帧提速或 GPU 带宽收益；正式 CPU/GPU P95 和完整 A0/B4 对照仍待 G09/G05 后续阶段。

### 保留的失败与限制

除上面的 Outline 提前释放缺陷外，第二轮完整矩阵在 Intel 的原有复用夹具中出现 `empty scene forward/false/1/false; RGB maxima=0`。此前集显偶发像素失败继续保留在[阶段三审计](resource-reuse-audit.md)，不能断言同因，也不能用专项通过宣称持续稳定性已达标。第一、第二轮证据均保留，最终工程检查和完整复核在下节记录。

最终完整复核再次在 Intel 的原有复用夹具失败，报告 `forward: pixel mismatch 1`。两轮均已通过独显全部项目、集显 G04 效果/AO 语义/输出、多视图与辅助语义；完整 runner 在复用失败处退出，集显阶段四专项另由前述独立双 GPU 记录覆盖。未放宽阈值，没有继续重复运行直到全绿；**完整兼容性与持续稳定性仍未通过，专项通过不豁免该问题**。

- [第一轮：Outline resize 提前释放](../../../artifacts/engine-0.2.1/g09/regressions-2026-10-02T00-17-13.710Z.json)
- [第二轮：Intel 空画面](../../../artifacts/engine-0.2.1/g09/regressions-2026-10-02T00-20-54.934Z.json)
- [最终完整复核：Intel 像素差异](../../../artifacts/engine-0.2.1/g09/regressions-2026-10-02T00-26-02.770Z.json)

## 最终工程检查与结论

- 定向测试 67/67，全仓测试 1,401/1,401，原生证据策略测试 8/8。
- 定向与全仓 typecheck/build、96 个示例构建、模块/责任/prepare/API/docs/no-rive 和 milestones 检查通过。
- 最终源码、runtime 及构建 chunks 与双 GPU 专项证据的指纹一致。当前为 dirty 开发候选，不是 clean release 证据。
- 没有 package/export 变更，本阶段未重复包消费安装门禁；完整发布门禁保留给最终候选。

阶段四实现和专项验证完成；完整原生兼容性、持续稳定性及正式整帧收益资格未通过，G09 保持 active。

[检查摘要与源码指纹](plan-cache-checks.json)；[全部命令日志（含失败轮次）](../../../artifacts/engine-0.2.1/g09/checks/stage4-2026-10-02T00-36-53.937Z/)。
