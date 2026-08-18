# ADR 0060：环境光遮蔽采用共享运行时与独立算法 Pass

- 状态：Accepted
- 日期：2026-07-29
- 影响：postprocess、scene texture、Shader Language、稳定 API 与浏览器像素门禁

## 背景

引擎已经能为后处理提供线性深度和 view-space normal，但缺少可直接组合的环境光遮蔽能力。GTAO、SAO 与 SSAO 共享输入和资源生命周期，却具有不同的采样与遮蔽模型；若分别复制完整运行时，会放大 bind group、uniform、resize 和销毁逻辑的维护成本。

## 决策

1. `@haiyue/engine/postprocess` 稳定导出 `GtaoPass`、`SaoPass`、`SsaoPass` 和共同的 `AmbientOcclusionPassOptions`，不进入根黄金路径。
2. 抽象基类、算法枚举、统计结构和 Shader Language reflection 继续作为实现细节，不扩大稳定 API。
3. 三个算法共享线性深度、view-space normal、相机投影参数、uniform 写入、bind group 缓存、resize 和销毁生命周期；算法本身保持为三个独立的构建期 Shader Language 产物，并共享一个生成期降噪/复合产物。
4. 采样质量固定为 8/16/32 三档，支持复合显示和 AO-only 调试。GTAO 使用双向 horizon ray march 与闭式余弦积分，SAO 使用距离归一化和有理衰减的 obscurance，SSAO 使用旋转半球采样以及有界的最小/最大深度差测试。
5. 归一化线性深度固定使用 `r32float`，view normal 使用 `rgba16float`；不能用 half-float 深度承载较大 near/far 范围，否则斜平面会产生量化条带和错误自遮蔽。线性深度必须逐 texel 读取，禁止跨轮廓插值；采样方向使用逐像素交错旋转以消除固定角度条纹。
6. 浏览器门禁必须分别执行 AO off、GTAO、SAO、SSAO 和 AO-only，验证 WebGPU 无错误、三种算法产生非退化且彼此不同的实际像素。
7. 算法使用完整 projection/inverse-projection 重建 view position，不能只依赖投影矩阵对角线；这同时覆盖非对称投影、正交相机和 reverse-Z。
8. 算法默认写入半分辨率 `r8unorm` raw visibility，再经过共享的半分辨率 16-tap 旋转 Poisson position/normal/luma filter，最后以全分辨率 depth/normal-aware 2×2 upscale 复合；滤波和放大都不得跨越物体轮廓或法线不连续面。`r16float` 只作为显式对照格式，采样使用 `textureLoad`，不依赖可选的 float filtering 能力。
9. view-normal G-buffer 必须先截取 inverse-transpose 结果的 xyz，再以 `w=0` 进入 view matrix；禁止串乘两个 `mat4`，避免对象平移通过 homogeneous w 污染法线。
10. AO shader 使用独立的生成 artifact slice；未使用 AO 的编辑器和 player 不得因为基础后处理依赖而携带 AO WGSL。
11. `radius` 使用 view-space 长度而不是固定像素数。三个算法都先在 view space 生成采样位置，再投影到屏幕；降噪核才根据中心深度把 view-space 半径换算成像素半径。固定像素采样会让同一世界空间狭缝随相机距离和角度改变遮蔽范围，因此不作为默认或稳定 API 语义。

12. 成本证据固定覆盖 720p、1080p、4K × low、medium、high × `r8unorm`、`r16float`，分别报告 AO、denoise、upscale 的 GPU P50/P95、scratch texture bytes 和逻辑 shader 读写字节估算。带宽估算不宣称等同物理显存流量，因为缓存、压缩、tile memory 和事务粒度由设备决定。
13. “32×”仅描述一张 half-resolution `r8unorm` raw AO texture 相对一张 full-resolution `rgba16float` raw texture；当前 raw + denoised 两张 scratch texture 合计为旧单张 scratch 的 1/16，不能表述为整条 AO 管线缩小 32×。

## 边界

- 本阶段不引入 temporal accumulation、separable bilateral 或 bent normal；先以分阶段 timestamp 和资源/带宽证据闭合 half-resolution 路径。只有现有窄缝、孤立凸面和视角稳定门禁继续通过，才会评估改变滤波时域或 tap 拓扑。
- AO 是屏幕空间后处理，不宣称替代烘焙 AO、光追 AO 或全局光照。
- 每个算法保持独立的 raw-AO draw，再共享 denoise 和 upscale/composite draw；公共实现只消除资源和生命周期重复，不在运行时拼接 shader 文本。

## 结果

- 材质和场景无需修改即可选择三种 AO 算法。
- 新算法可以继续复用同一输入 ABI，同时保持独立的生成、测试和像素归因。
- 稳定 postprocess 入口只增加四个有意符号，默认引擎入口不增长。
