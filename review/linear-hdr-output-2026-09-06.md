# 统一线性 HDR 输出实现评审

本轮对应“将色调映射从 PBR 材质移到统一输出阶段”，承接已有多视图辅助纹理、几何/材质语义对齐和运动向量 TAA 修改。架构决策见 [ADR 0096](../docs/for-ai/adr/0096-scene-linear-hdr-output.md)。未修改无关的 indexed-sprite 工作，也未更新 API 或性能预算来覆盖失败。

## 行为

- Render3DSystem 的场景、用户后处理和 TAA 历史保持 rgba16float 线性 HDR；末端统一曝光、Reinhard、sRGB 编码。
- PBR/Blinn 移除材质内显示转换；Fog、Basic、天空使用线性颜色。透射直接读取线性捕获；平面镜和可选浮点 RTT 不做显示转换。
- opaque 覆盖率、alpha/加法层、FXAA alpha、局部 viewport 和后续 MSAA load/resolve 均纳入验证。
- 自定义材质 renderer 使用 context.colorFormat。多个独立 3D 系统通过显示层合成，需要共享深度的对象应属于同一个系统。

## 验证记录

- 新增真实 Chrome 152 / NVIDIA Pascal WebGPU 输出诊断：17 项通过，零 validation error。对纯发光/Basic/Blinn 的解析期望颜色、HDR 值、曝光前 TAA 历史、Fog/透射、透明及加法叠加逐像素断言。包括 Toon opaque 覆盖率与混合材质共用输出。最后一项确认临时反射目标也使用 rgba16float 并保留原始 (4, 2, 1) 辐射。
- 新增 5 项结构测试覆盖输出参数隔离、重复上传抑制、提交后回收、MSAA 附件和 RTT 格式/字节数。
- 根 typecheck、1224 项测试（shader-language 112、Engine 594、animation-spec 139、extensions 372、catalog 7）、模块边界、职责边界、renderer prepare 和 docs 检查通过。最后两项补丁再次通过 Engine typecheck/build、全部 Engine 594 项和 shader-language 112 项测试。
- 既有 TAA 25 项、辅助语义 7 项、多视图 5 帧以及 shader stage 8/10/11 的 Chrome/WebGPU 验证通过；多视图辅助纹理 12/12 退出，零 validation error。
- 根构建按 7 个相关示例限定范围运行并通过：pbr-showcase、taa-postprocess、motion-blur、planar-mirror、rtt、shader-language-lab、shader-language-character-material，包含所有核心 workspace 及共享示例 bundle。最终补丁对应示例已全部刷新，9 个构建目标（含共享 bundle 和 source viewer）的 freshness 检查通过。
- Shader Language Lab 和角色材质展示页浏览器验证通过。Lab verifier 原先读取共享 runner 已不提供的 navigationErrorCount；现在断言包含页面及导航清理过程的 browserDiagnostics.unclassifiedFailureCount 为 0，保留零错误要求。共享 runner 相关测试通过。
- Shader 生成产物一致性、shader-language 单元测试与 stage14 边界检查通过；shader-language:check 和 stage14 DAG 均被既有预算体系拦下。

## 成本与未通过项

当前生成 WGSL 355427 字节（预算 328000），相对预算基线增长 49923 字节（预算 22500）；生成文件增长 2（预算 1）。此前累计工作已超过字节预算，本轮新增末端 shader 又使文件增长超过预算。没有放宽阈值。生产共 58 个 pass、66 个生成 WGSL 文件，数量总预算仍满足。

反射综合 smoke 在预算断言处失败：`render3d.planar-reflection.1000e.1m.1b.1v` 的 pass 数为 6，预算为 4。两个执行视图各新增一个输出 pass；保留原阈值。由于该综合门禁先校验成本，它没有继续运行后面的旧像素基线比较；反射 HDR 正确性由独立输出诊断和镜面结构测试验证。此结果不能称为反射性能门禁通过。

`api:check` 仍因现有 workspace graph、音频、simulation、GUI、动画公开符号与基线不一致失败。本轮没有修改这份基线。

本轮每个 3D 视图新增一次全屏输出 draw/pass；HDR 场景颜色每像素 8 字节，还需场景深度，MSAA/用户效果按配置增加附件。输出参数每视图 16 字节，稳定参数只上传一次；每目标格式最多 4 条 runtime pipeline。当前 GPU 诊断属于正确性证据，不构成帧耗时改善或正式性能准入结论。
