# 0095：运动重投影、独立深度历史与视图级时域生命周期

- 状态：Accepted
- 日期：2026-09-05
- 更新 ADR 0029 的 TAA 重投影、历史纹理和依赖条款，以及 ADR 0034 的 motion 格式与抖动条款；其他决策继续适用。

## 背景

仅由当前深度和相机矩阵重建历史位置无法描述物体独立运动。已有 motion renderer 已保留刚体、morph 和 skin 的前后帧状态，TAA 应消费同一套结果。历史深度放在显示颜色格式的 alpha 中会降低深度精度，也无法保存原始透明度。

## 决策

1. Motion v2 使用 `rgba16float`：XY 为移除投影抖动后的 `currentUv - previousUv`，Z 为对应表面上一帧的归一化线性深度，W 为历史有效性（1 有效、-1 当前表面没有连续历史、0 没有 motion 覆盖）。Motion Blur 继续只读取 XY。投影抖动不能在静止物体上产生物理速度。
2. Motion 对象 uniform 从 240 扩展为 272 字节，追加 camera depth 参数和 UV jitter delta；CPU packer、WGSL、反射、验证器共同迁移。几何变形 ABI v1 保持不变，新增 `temporal-motion-v2` pass requirement 标识这次内部时域 ABI。
3. TAA 自动申请 depth 和 motion，不要求同时安装 Motion Blur。颜色历史使用双缓冲 `rgba16float`，深度历史使用双缓冲 `r32float`；同一次全屏 draw 输出显示颜色、历史颜色和历史深度，共三个颜色附件。历史 alpha 保留当前颜色 alpha，历史 RGB 不包含显示锐化。
4. TAA 历史位于稳定输出网格，前一帧坐标是 `currentUv - motion.xy`，不能再次叠加 jitter delta。没有 motion 覆盖的远背景才使用相机重投影；该路径须取消矩阵中的 jitter 差值。有限深度但缺失 motion、刚出现的物体和无效投影拒绝历史。
5. 当前 3×3 邻域选择最近表面的深度及配对 motion，并保存该深度供下一帧验证，允许亚像素轮廓在投影抖动时累积覆盖样本。历史双线性采样先分别验证四个 tap 的深度，再对有效颜色归一化；不插值深度来构造不存在的表面。颜色采用 YCoCg 邻域范围及方差裁剪，反馈随有效采样权重、颜色/alpha 差异及速度降低。
6. 历史按 view key 隔离。相机身份、投影形状、尺寸、输出格式、近远面、深度约定或帧连续性变化会拒绝旧历史；抖动变化自身不会触发切镜。`resetHistory(viewKey?)` 同时使对应颜色历史和 renderer-owned motion 历史失效。`getMotionHistoryRevision(viewKey?)` 支持按视图查询，不扩张稳定导出概念数。
7. 替换、过期和卸载的历史资源在当前编码提交后、队列完成时退休。后处理执行器通过内部 submission scope 提供这个边界，公开 frame context 仍只保存帧数据。直接调用 `apply()` 且没有边界时，替换资源保留至 `destroy()`。
8. Motion Blur 的不同尺寸使用独立 uniform、tile 参数及临时纹理，并在相同尺寸再次出现时复用。不能在同一个 command encoder 内覆盖另一视图的尺寸 uniform，或销毁其已引用的纹理。失效资源通过同一提交边界退休。

## 成本和边界

每个 TAA view 的双缓冲历史占 24 字节/像素（1080p 约 47.5 MiB），motion v2 占 8 字节/像素。增加的是精度、深度验证和运动元数据所需资源；没有新增静态 deformation 变体，TAA 仍为一次 resolve draw。

透明多层覆盖、粒子/自定义 shader 的专用速度、reactive mask、曝光补偿和时域超分仍不属于本次契约。屏幕空间单层 motion 不能推断这些表面的完整历史；邻域裁剪也不构成任意透明场景无拖影的保证。剧烈切镜、seek 和 teleport 仍通过显式 reset 协议处理。

## 实现与验证入口

- [时域 shader 契约](../../../shader-language/temporal-postprocess-extension-contract.json)
- `engine/test/taa-temporal.test.mjs`
- `node scripts/verify-webgpu-taa-temporal.mjs`
- `examples/taa-postprocess` 和 `examples/motion-blur`

抖动与运动分离、时域重投影的设计参考 [AMD FidelityFX 时域集成文档](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-temporal/)。本实现使用项目自己的 renderer 和 shader，没有引入 FSR。
