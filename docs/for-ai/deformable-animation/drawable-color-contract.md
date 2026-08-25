# Deformable drawable color contract

状态：HYDM 1.2 contract/conversion + WebGPU runtime + licensed corpus accepted candidate（M05 G13/G15/G16）

## 语义

- `multiplyColors` 与 `screenColors` 是来源无关 drawable tint，不是 `multiplicative` framebuffer blend，也不是 state-machine additive layer。
- 两个通道均为 drawable-local、frame-major RGBA Float32，布局是 `frameCount * 4`，在相邻 baked frame 之间线性采样。
- Neutral 只由 RGB 决定：multiply RGB 为 `[1,1,1]`，screen RGB 为 `[0,0,0]`。Alpha 保留和混合，但 Cubism drawable color 计算不消费它，也不能替代 drawable opacity。
- 缺失通道使用现有 pose 默认：multiply `[1,1,1,1]`，screen `[0,0,0,0]`。这也是 HYDM 1.0/1.1 的解码语义。

## Binary ABI

- Header major 保持 `1`。Minor `1.2` 在 drawable metadata 增加可选 `multiplyColors` 与 `screenColors` Float32 pool ranges。
- Writer 只在至少一个 RGBA 值不同于缺省轨道时写 1.2；全缺省轨道省略并继续写 1.1。
- 1.2 decoder 继续接受 1.0/1.1。1.0 禁止 `maskMode`，1.0/1.1 禁止 drawable color range；未知 1.3+ 和未知 major 在创建 typed views 前拒绝。
- 每个 color range 必须精确包含 `frameCount * 4` 个值，并参与 Float32 pool 的完整无重叠 partition。所有分量必须 finite 且位于 `[0,1]`。

## Capture、conversion 与 sampling

- 新 Core capture 工具设置 `capabilities.drawableColors` 为 `captured` 或 `unavailable`。显式 unavailable 在 normal 模式产生 `W_CUBISM_DRAWABLE_COLOR_UNAVAILABLE`，strict 模式失败；legacy capture 未声明 capability 时保持兼容。
- 声明 `captured` 后，任一 drawable/frame 缺少 RGBA 或出现越界/非有限值，使用 `E_CUBISM_DRAWABLE_COLOR_INVALID` 和精确字段 path 失败。
- Core 的 `[-1e-4, 1+1e-4]` 浮点插值漂移按既有 opacity policy clamp；更大漂移失败。
- Adaptive sampling 的 interpolate/error/quantize/dirty attribution 包含两个 RGBA 通道；converter report 分开记录 multiply 与 screen 的 drawable count 和 drawable-frame count。
- 通用 pose sampler 把缺失旧轨道注入 neutral 值，并把 1.2 颜色直接写入 caller-owned buffer；seek、loop、override 与 additive mixer 不依赖上一帧。

## Runtime composition order

G15 冻结的顺序与官方 Cubism Web premultiplied-alpha shader 一致：

1. 以 `rgba8unorm`、`colorSpaceConversion: none` 读取 display-encoded texture bytes；deformable 纹理在上传边界已预乘 alpha。普通 straight-alpha visual 先在 shader 内预乘，neutral 结果与旧路径一致。
2. `rgb = rgb * multiply.rgb`。
3. `rgb = rgb + screen.rgb * textureAlpha - rgb * screen.rgb`。因此 screen 不会给完全透明 texel 增色。
4. 乘来源无关 base color 和 drawable/model opacity；multiply/screen 的 A 不参与此步。
5. 乘 normal/inverted/multi-source mask coverage。
6. 以现有 `normal`、`additive` 或 `multiplicative` framebuffer blend state 合成。

Setup-mask pass 跳过第 2/3 步并只由纹理 alpha 生成 coverage；非中性 screen/multiply 不扩大或缩小 mask。Effect source 使用与 main drawable 相同的颜色公式。

`AnimationVisual2D` 的 object uniform 从 1264 bytes 扩为 1296 bytes，在既有 bind group/buffer owner 中新增两个对齐的 `vec4<f32>`。逐帧只写现有 buffer，不创建 GPU resource；连续颜色值不进入 pipeline key，G14 的 `none:ccw` / `back:ccw` culling 维度保持不变。

## Diagnostics and evidence

- 通用 visual 对非法 multiply/screen tuple 分别抛出 `E_ANIMATION_2D_MULTIPLY_COLOR_INVALID` / `E_ANIMATION_2D_SCREEN_COLOR_INVALID`，path 是 `$.multiplyColor` / `$.screenColor`；非 finite、长度错误和 `[0,1]` 越界均不会写入 uniform。
- CPU oracle、generated-shader `rgba8unorm` readback 覆盖 neutral、multiply、screen、组合、透明边缘、opacity、普通/反相/多 source mask、三种 blend、culling、动作切换、resize 和 device recovery；最大误差为 1/255。
- MIT paired fixture 在相同 texture bytes、time、viewport、背景、预乘和 color configuration 下比较 WebGPU HYA 与冻结 WebGL reference：4 个 multiply 与 4 个 screen drawable，最大误差 2/255、mean absolute error 0.011979、mismatch ratio 0。

## G16 corpus acceptance

- 官方 Mao runtime hash `sha256-1add506b…dec5bc9` 在 `Idle:0 / 1s` 实测 54 个 non-neutral multiply drawable-frame 和 38 个 non-neutral screen drawable-frame；代表值分别是 `ArtMesh82=[0.980392,1,0.427451,1]`、`ArtMesh194=[1,0.454902,0.513726,1]`。
- 同一资源、pose/time、viewport、fit、背景、alpha 和 texture/color 配置下，官方 Core/HYA surface readback 的 max channel error `180`、mean absolute error `0.346908`、mismatch ratio `0.013038`，均通过冻结阈值；device recovery 通过且 `unclassifiedFailureCount=0`。
- 机器可验证 recipe、许可、文件 hash、逐 drawable path 与颜色 observation 位于 G16 manifest/candidate。原始 Mao 模型、纹理、Core 和 pixel reference 不分发；G09 已在 `review/m05-live2d-pixel-baseline-approval-2026-08-25.md` 对候选精确字节和 producing revisions 完成人工批准。
