# ADR 0099：先按视图选择灯光，再评估 clustered

- 状态：Accepted
- 日期：2026-09-06
- 关联：[ADR 0021](./0021-benchmark-driven-lighting-shadow-scale.md)、[ADR 0027](./0027-render-view-family-execution.md)、[ADR 0098](./0098-gpu-driven-indirect-bundle-submission.md)

## 问题

固定 forward 容量原先由实体遍历顺序决定。前面的弱灯、远处灯可能占满八个槽位，后加入的关键点光无法照亮画面。直接引入 clustered 不能替代正确的灯光准入规则。按视图选灯还要求修改 GPU 灯光记录的所有权：同一提交中的多个视图不能反复覆盖同一个 uniform 区域。

## 决策

保留八灯 forward 和三层方向光阴影。World/FrameData phase 只通过组件索引收集一次候选，解析线性色彩和点光世界位置。视图消费已经快照化的 SceneFrame 矩阵和眼睛位置，不读取可能被后续视图规划改写的 camera 缓存。PBR、Blinn-Phong、Toon、Instanced PBR 使用同一准入服务。

1. 排除 disabled 层级/组件、非正强度、无效颜色/方向/位置，以及非正或非有限 range。无效光源不占用阴影槽。
2. 按线性亮度乘强度选择至多三盏阴影方向光。已有候选获得 10% 的保留权重；入选结果按实体 ID 排序，作为所有视图共享的前几个光源槽，与 shadow array layer 一致。
3. 点光以影响球与视锥相交为准入条件，球半径保留 1% 保守余量。光源中心在屏幕外仍可能照亮可见表面，不能仅检查中心，也不能要求相机处于点光 range 内。
4. 其余槽位按线性亮度、强度和近似投影影响范围选择。点光权重乘 `min(1, range / distanceToEye)^2`；方向光和环境光不使用距离。上一轮入选灯获得 10% 保留权重。相同权重以实体 ID 决胜，入选后的非阴影槽按 ID 排序，避免分数细微变化触发槽位重排和上传。
5. 非阴影选择使用容量固定的插入列表，工作量为 O(候选数 × 8)，不进行逐对象灯光列表构造或 GPU 回读。没有新增 compute/render pass。

以上是视图级影响估计，不能保证每个可见物体都获得其最重要的八盏灯；视锥相交也不代表存在实际受光表面。正交视图仍使用上述统一距离权重。暂不增加手动 priority、layer mask 或局部灯光列表 API。

## 缓冲、失效与生命周期

四类照明 renderer 统一使用内部 ViewLightUniformBuffer 的 528 字节 CPU packer。WGSL 字段、八灯数组长度和 shader ABI 不变；CPU 灯光 binding 增加动态偏移和明确的 minBindingSize/size。PBR、Blinn、Toon 仍位于原 group 3，实例化路径仍位于原 group 1 binding 4，没有借用其他 shader group。

每个 renderer 拥有可增长的 uniform buffer；相机/viewport SceneFrame stream 对应三个记录区。稳定视图与区域复用偏移，按最终 float32 内容跳过重复上传。Render Bundle 缓存同时纳入灯光动态偏移，GPU buffer 扩容时重建相关 bind group，旧 buffer 由 FrameRingResource 在提交完成后退休。同一个 encoder 内重复修改同一区域时使用临时记录，不能覆盖已录制视图。

初始容量为 32 个对齐记录；256 字节对齐设备上每个照明 renderer 初始约 24 KiB。120 个新 encoder 未使用的视图记录退出缓存，其索引在 afterSubmit 后等待队列完成再复用。没有 afterSubmit hook 的低层调用保守保留这些索引/退休代到 destroy。renderer 销毁或设备恢复释放旧 owner，不能跨 device 复用。环境光仍是场景数据，以内容比较避免不同视图 lightingRevision 交替导致相同 IBL uniform 反复上传。

选灯在现有 prepare-pbr-lighting 阶段为全部材质执行，该阶段现在显式依赖 camera-frame；其 pbr-lighting 资源代表已选灯的准备结果。实例化系统在自己记录视图前使用相同服务。

## 诊断与 API 审核

SceneRenderEnvironment.lightSelection 提供 candidateCount、rejectedCount、outsideViewCount、eligibleCount、selectedCount、overflowCount、replacementCount。计数为当前视图/phase，不通过查询诊断再次扫描 ECS。lightingRevision 只跟随入选灯与 IBL 数据改变，落选灯或视锥外灯的编辑不会单独导致视图上传。

现有 experimental getSceneRenderEnvironment 增加可选 SceneFrameUniformSnapshot 参数，省略时返回场景级重要性选择；现有 SceneRenderEnvironment 增加可选只读诊断字段。没有新增 stable/root 符号、profile 开关或 package subpath。选择器、packer 和 GPU 缓冲实现保持私有，不更新已有无关 API 基线差异。

clustered 继续遵循 ADR 0021 的真实场景证据要求。先观察持续的有效 overflow、灯光空间分布和实际受光重叠，再测 CPU 选择/提交、GPU 着色、上传、分配及显存，比较 forward、CPU tiled/clustered 与 GPU clustered。这里的视锥 overflow 是调查信号，不是 clustered 准入结论，也不能把总 authored light 数直接当作需要 shading 的灯数。

## 验证

单元测试覆盖重要性、遍历顺序、保守球相交、无效光、稳定滞回、视图 revision、阴影槽、同一提交记录隔离、扩容退休和视图退出缓存。真实 GPU 将双视图选灯与逐视图仅保留预期灯的独立场景作像素对照，并检查静态上传、资源残留与原 indirect bundle 路径。

测量与门禁状态见[评审记录](../../../review/view-light-selection-2026-09-06.md)。
