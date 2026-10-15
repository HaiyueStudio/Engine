# Haiyue 0.2.1 发布候选

0.2.1 尚未发布。本页说明候选能力与升级边界；当前设备证据、性能资格和剩余发布工作统一见[验收结论](../../review/engine-0.2.1/README.md)。版本号、示例可运行或单项测试通过均不表示完整发布资格。

## 多灯与 FrameGraph

- 通过 `@haiyue/engine/experimental/renderer` 的 `createDeferredLightingProfile()` 显式选择 `reference` 或 `tiled`。提供完整灯表、逐视图列表、容量诊断及主动调试读回；普通场景继续使用默认 Forward。接入见 [Deferred 多光源指南](deferred-lighting.md)和[可运行示例](../../examples/deferred-lighting/main.ts)。
- FrameGraph 根据输出、历史和副作用依赖裁剪无消费者步骤，复用兼容的临时纹理，缓存有界的结构计划；每帧仍绑定当前资源。检查器按需捕获，不把导出或读回成本混入普通帧。
- 修复运动向量、镜面和输出绑定组的过期诊断引用，以及已释放 owner 的元数据保留。资源按既有 GPU 提交生命周期退休。
- 多灯示例在加载阶段完成两次真实绘制及 GPU 完成等待，然后开放交互。进入交互后的帧节奏独立验收，加载时间不计作稳态帧率。

Deferred 使用单采样路径；材质、透明、AO、阴影及回退范围见指南。512/1024 灯属于压力诊断，局部灯阴影、CSM 和 3D clustered 不属于本次新增能力。临时纹理分配下降不等于相同比例的实际显存或帧率改善。

## GPU 实例与扩展

实验性 GPU 实例路径支持应用拥有的状态缓冲、逐视图剔除、三档 LOD、间接绘制与有界异步读回；普通动画帧无需全量回读实例状态。参见 [GPU 实例指南](gpu-instances.md)、[API 契约](../api/gpu-instances.md)和 [10,000 实例示例](../../examples/gpu-instances/main.ts)。应用负责设备替换后的状态重建，桌面示例不构成手机性能承诺。

Animation2D 与 HYA 状态机只在准备文本引用的 `fontResource` 时异步加载 OpenType 解析器。系统字体或无文本的动画无需下载解析器；解析失败、资源准备和场景销毁遵循[字体生命周期](asset-lifecycle.md#动画文本字体准备)。运行时切换与延迟准备需要同时检查 pending 和 failed 资源计数。

`@haiyue/extensions` 按领域提供动画、资产、文本和交互等能力；稳定性以[包入口清单](../../extensions/package.json)及 [API 规则](../for-ai/api-stability.md)为准。文件数量不作为功能完整性的替代指标；发布仍校验导出、依赖边界、实际消费者及包体预算。整组 loaders.gl 使用已核验的受控版本范围。

## 升级、回滚与设备范围

四个发布包为 `@haiyue/engine`、`@haiyue/animation-spec`、`@haiyue/extensions`、`@haiyue/shader-language`，候选版本均为 0.2.1。稳定 Engine 根入口保持 30 个概念；Deferred、GPU 模拟和 FrameGraph 检查器沿用明确标注的 experimental 入口，HYA 格式与 Shader artifact 版本独立管理。Rive 不在本次发布范围，UI、Editor、Games 保持各自发布节奏。

升级前保留应用锁文件及所用包的完整版本集合，在隔离消费者中验证安装、渲染、资产加载和销毁。启用 Deferred 是应用的显式选择；仅升级包不会把默认 Forward 自动换成多灯路径。回滚时恢复原锁文件和匹配的完整包集合，重建应用产物，避免混用不同版本的运行时与声明文件。

必需设备验收采用一条完整原生路径：Windows 独显 Chrome＋Edge，或 macOS Apple Silicon／AMD Metal Chrome。旧 Intel Gen9 为扩展兼容，已知失败继续保留；移动端能力声明需要对应真机证据。详细环境要求见[浏览器与设备要求](browser-requirements.md)，本机测试范围和已知性能问题见[当前验收结论](../../review/engine-0.2.1/README.md)。
