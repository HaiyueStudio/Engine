# ADR 0096：场景线性 HDR 与统一输出阶段

- 状态：Accepted
- 日期：2026-09-06
- 关联：[ADR 0095](./0095-motion-reprojected-temporal-antialiasing.md)、[输出合同](../../../shader-language/linear-hdr-output-extension-contract.json)

## 背景

PBR、Blinn 在材质内执行 Reinhard 和显示编码，天空也提前压缩亮度，导致混合材质、Fog、透射和 TAA 的输入空间不一致。透射依赖反解显示颜色，无法恢复被 UNORM 截断的能量。

## 决策

`Render3DSystem` 始终使用独立的 `rgba16float` 场景颜色附件。内置材质、天空、Fog、透明混合、透射捕获和用户后处理依次在线性空间执行。TAA 历史保存曝光前的 HDR。引擎在用户效果链末尾附加私有 `SceneOutputPass`，空效果链同样经过此输出阶段。

UNORM 目标依次应用 `exposure`、可选 Reinhard 与分段 sRGB 编码。默认 exposure=1、toneMapping='reinhard'；'none' 只关闭曲线，仍保留曝光与显示编码。sRGB 目标由附件完成编码。`rgba16float`、`rgba32float` 和 `rg11b10ufloat` 目标直接保留场景线性颜色，跳过曝光和显示转换。

平面反射内部目标使用 rgba16float。作为另一个 3D 场景输入的 `RttTexture` 应显式配置 `format: 'rgba16float'`。RTT 池按格式区分兼容性并按实际格式核算字节数。显示用途的 RTT 仍可使用默认格式。

Basic 颜色和 Fog CPU 打包为线性颜色；Basic 通过 AssetManager 加载的颜色、发光图片使用 sRGB 纹理格式。直接传入的 GPUTexture 由调用方保证色彩空间正确。独立低层 renderer 输出线性颜色，调用方负责其输出边界。注册到 Render3DSystem 的自定义 renderer 必须使用 `MaterialRendererViewContext.colorFormat` 构建颜色附件。

## Alpha、视图和提交

场景附件保存预乘 alpha；普通 alpha 混合由固定管线生成预乘结果。PBR opaque/mask 和 Basic opaque 的覆盖率为 1。Basic 的 48 字节材质 UBO 使用原 padding 的 offset 40 保存 opaque 标志，CPU、反射和普通/蒙皮 shader 同步迁移。Blinn opaque 同样写入覆盖率 1；Toon 的 params.w（offset 108）保存 opaque 标志，保持 240 字节布局。输出阶段先还原直通 RGB，转换后再预乘；alpha=0 的加法辐射保留，避免透明背景吞掉加法层。FXAA 对 RGBA 使用相同权重，保留覆盖率。

`loadOp: 'load'` 表示先把当前 3D 视图绘制到透明 HDR 层，再合成到既有显示目标。不同 Render3DSystem 的深度互相独立；需要共享遮挡和线性混合的几何应放在同一个 Render3DSystem。后续 2D/UI 继续在显示目标绘制。

局部 viewport 使用局部 HDR 尺寸，末端映射到目标偏移并保留区域外像素。MSAA 输出同时写入显示 MSAA 附件和 resolve 目标，并保留 samples，确保后续 UI load/resolve 不覆盖场景。按 view key 隔离输出参数缓冲，内容不变不重复上传；过期资源经 afterSubmit 和队列完成再回收。

## 成本与验证

新增一个 static output pass：独立 16 字节 pass UBO 和目标格式/alpha 合成职责要求其拥有独立 layout。运行时每目标格式最多缓存 1/4 samples × 覆盖/叠加，共 4 条 pipeline；曝光和曲线为 uniform，不生成 shader 变体。生产 pass 数增加 1，既有数量与字节预算不放宽。

每个执行的 3D 视图增加一次全屏输出 draw/pass；无用户后处理时也需要 8 字节/像素的 HDR 场景颜色和自己的深度，MSAA 或效果链额外附件按实际配置分配。多种尺寸复用现有生命周期缓存。这里没有声称性能提升，收益是恢复一致的渲染语义与 HDR 动态范围。

历史 stage/AO/temporal 合同保持不变，当前 artifact 身份由新的输出合同锁定。GPU 诊断覆盖混合材质、HDR 捕获、TAA、曝光、Fog、透射、天空、alpha/加法叠加、FXAA、视口及 MSAA 后续 load；结构测试覆盖上传复用、提交回收与 RTT 格式隔离。具体门禁结果记录于 [评审记录](../../../review/linear-hdr-output-2026-09-06.md)。
