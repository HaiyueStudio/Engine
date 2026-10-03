# ADR 0111：帧计划活跃根与后处理读写裁剪

- 状态：Accepted
- 日期：2026-10-01
- 关联：[ADR 0076](0076-render-plan-execution-and-parameterized-renderer-core.md)、[ADR 0097](0097-auxiliary-mrt-and-frame-resource-dependencies.md)；M18 G09 依赖与裁剪子阶段

## 决策

Render3DFramePlan 的数据生产者默认可裁剪，导出资源与显式 sideEffect 才是活跃根。先校验全部声明（包括死分支中的缺失生产者、循环与非法版本），再从根回溯执行；错误计划不得先执行 CPU/GPU 动作。导入和导出继续采用已有资源版本合同。

Deferred 子图将光照 AO 的辅助深度、法线、frame context 明确列为生产者输出，resolve、特殊不透明与透明光照显式读取 AO。无 AO 时仍保留中性绑定的提交保护与旧资源退休，不能误把生命周期管理当作无用计算裁剪。G-buffer 与调试 readback 的所有权和可用期不变。

后处理使用已有 RenderGraph 声明逐效果的颜色版本与辅助输入。已审核的内置无历史效果可裁剪；AO occlusion 输出不消费上游颜色内容，但仍需有效且不与输出重叠的 source 绑定。AO 的帧计数推进必须保留。TAA、MotionBlur、自定义效果及内置效果的子类保守保留执行和上游颜色，不根据 label 推断纯度。

物理 ping-pong 继续归 PostProcessRenderer，按保留节点的顺序选择 source/destination，不使用被裁剪节点的旧下标。逻辑内容依赖与 WebGPU 绑定使用分别处理；本阶段不利用这份图做物理别名分配。准备、pipeline warmup、辅助纹理需求和实际运行采用同一裁剪规则；被裁剪的效果不分配或录制，已准备但不再活跃的效果沿用既有提交退休边界释放。

## 范围

这是现有图的依赖与裁剪集成，不引入新 stable API，不改 Shader、AO 语义、灯光覆盖、资源预算或性能阈值。Forward 主场景、scene-global 阴影、镜面、外部 RTT、TAA 历史和未知效果保持必要输出/状态。Deferred 与后处理仍是有显式边界的子图；物理资源统一分配、计划缓存、pass 合并及完整跨设备收益验收留在 G09 后续阶段。

## 验证

合同测试验证活跃根、死分支、失效前零执行、历史/自定义效果保留与图清理。实际 AO occlusion 场景验证前置无用颜色效果被裁剪，GPU 输出与直接 AO 对照相同，composite 模式仍保留颜色链。定向 native 检查覆盖辅助语义、多视图、Deferred AO 与释放。结构计数的减少不等于正式 CPU/GPU P95 收益；当前进度及证据见 [G09 索引](../../../review/engine-0.2.1/g09/README.md)。
