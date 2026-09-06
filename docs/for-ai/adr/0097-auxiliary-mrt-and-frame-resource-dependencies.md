# ADR 0097：辅助缓冲 MRT 与帧资源依赖

- 状态：Accepted
- 日期：2026-09-06
- 关联：[ADR 0095](./0095-motion-reprojected-temporal-antialiasing.md)、[ADR 0096](./0096-scene-linear-hdr-output.md)、[辅助输出合同](../../../shader-language/auxiliary-surface-extension-contract.json)

## 决策

辅助表面先比较深度写入列表与运动列表，过滤无几何、无变换、无材质以及不写深度的对象，并保持原有排序。只有过滤后的对象引用及顺序完全相同时，运动 pass 才同时输出所需的深度、法线；这也保留相同深度处的覆盖顺序。没有运动需求时，法线 pass 可以同时输出深度。仅需深度时继续使用 DepthRenderer。

写深度的透明 Basic 材质使两个列表不等价，此时深度和法线合并、运动单独绘制。选中物体完整 mask 包含被遮挡表面，visible mask 则读取主场景深度，两者保持独立。这里不把主场景的多采样深度直接视为单采样辅助深度。

MotionVectorRenderer 的 location 0 和 272 字节历史 UBO 保持 temporal-motion-v2。location 1/2 分别是可空的 r32float 线性深度与 rgba16float 视空间法线。deformationFlags.w（offset 236）启用法线计算；四个 morph buffer 改成 position/normal 交错的 24 字节步长，新增第 8 个 vertex buffer 绑定基础法线。用当前 morph/skin 与模型逆转置得到法线，保留非均匀缩放及镜像缩放的方向语义。历史只在一次运动绘制后更新。

NormalRenderer 的 16 字节参数块用原 padding 的 offset 4/8 保存 near/far，并向 fragment 开放绑定；location 1 可选写深度。辅助深度和法线材质按 view key 分开缓存，避免一次提交中不同相机的参数互相覆盖。对象、几何数据仍由原 renderer 缓存共享，不为每个视图复制几何。

没有新增 static shader pass。运动和法线分别最多有 4/2 种附件组合，缺少的目标使用 null；目标数量与格式是 runtime pipeline cache key 的一部分。最多 3 个颜色附件、20 字节/采样，使用最多 8 个 vertex buffer。CPU 绑定、WGSL、反射和当前 artifact 身份在新合同中同步，历史 temporal/output 合同不重写。

## 帧计划

Render3DFramePlan 使用已有 RenderGraph 编译阶段读写声明。外部状态必须显式 import，对外可见的显示目标和下一帧历史必须 export；资源采用单写入者、带版本名称。编译拒绝缺失生产者、重名 pass、多写入者、覆盖 import、同版本读写、缺失显式依赖与循环。整个计划通过校验后才执行 CPU/GPU 阶段。

每个视图声明收集、排序、GPU 命令、透明排序、PBR 光照、场景颜色/深度、材质资源、所需辅助纹理及历史的依赖。辅助缓冲从后处理动作中拆成独立节点；无需求时不声明该节点和对应资源。最终输出与历史为非瞬态资源。快照包含 reads/writes/dependsOn，计划同时提供 firstUse/lastUse 和依赖数量。快照数组由 owner 复用，仅代表最近一次执行。

这是阶段级资源计划：主场景内的透射捕获，以及效果链内的 ping-pong、TAA 历史，仍由各自 owner 排序与分配。视图之间的阴影/反射依赖仍由外层计划管理。此变更没有引入跨帧别名分配、自动 GPU 并行执行或提前销毁；实际纹理生命周期继续经 afterSubmit 和队列完成管理。计划图节点仍按视图编译，不宣称 CPU 零分配。

## 验证

资源计划测试检查拓扑排序、失败前零执行、视图清理、导出属性与按需辅助节点。真实 GPU 夹具对比合并与独立 renderer 的像素，覆盖 mask/UV1、morph/skin、非均匀缩放、透明深度写入者、附件切换及同次提交不同相机 near/far，并保留 TAA、多视图回收和 HDR 输出回归。

`auxiliaryStats` 记录最近视图的实际/未合并表面 pass 和 draw 数。GPU 诊断分别记录 CPU 录制、GPU timestamp、队列等待、上传、分配及释放后残留。这些小场景用于验证结构和正确性，不作为大场景帧率提升的证据。当前测量与门禁见[评审记录](../../../review/auxiliary-mrt-frame-plan-2026-09-06.md)。
