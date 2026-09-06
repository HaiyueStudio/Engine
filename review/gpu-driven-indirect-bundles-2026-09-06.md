# GPU-driven CPU 提交成本修复

日期：2026-09-06。实现边界见 [ADR 0098](../docs/for-ai/adr/0098-gpu-driven-indirect-bundle-submission.md)。

## 变更

- 六类内置 opaque renderer 复用兼容区间的 Render Bundle，跳过稳定帧的逐对象资源查找、绑定与 indirect draw 编码。
- 每个 draw 仍消费独立的 GPU indirect 参数，支持剔除空洞和非连续 object slot。
- 用实际 GPU 资源身份、动态偏移与附件布局判断失效，弱引用 view-ring 缓冲，并限制区间缓存大小。
- GPU 绘制统计按每次 bundle 执行计数；CPU 编码和缓存命中另行统计。

## 诊断证据

入口：`node scripts/verify-webgpu-indirect-bundles.mjs`；产物：`artifacts/webgpu/indirect-bundles-diagnostic.json`，包含 source fingerprint、git revision/dirty、Chrome、NVIDIA Pascal 设备与采样信息。该工作区有先前修复和其他未提交改动，证据不是正式干净 runner 的发布性能基线。

10 组真实 GPU 对照覆盖双视图及六类材质、剔除空洞、indexed/non-indexed、morph/skin 与 pose 更新、逐对象 clipping、texture/alpha mask、透明叠加、删除/扩容、MSAA/reverse-Z。两个视图逐像素比较原逐对象间接提交，最大误差 0。WebGPU validation error 和 owner residual 均为 0。

600 个 opaque 对象、一个透明对象、两个视图，按原提交 / bundle / bundle / 原提交顺序执行四个 cohort，每个预热 6 帧、采样 16 帧。逐对象基线使用相同 renderer、prepare/upload、shader 和 GPU culling command buffer，仅替换提交函数，避免将别的 profile 的剔除或实例化差异混入比较。时间包含共享审计和诊断开销，汇总取各 cohort 中位数的中位数。

| 稳定帧指标 | 原逐对象提交 | Bundle 提交 |
| --- | ---: | ---: |
| GPU draws | 1204 | 1204 |
| Render passes | 4 | 4 |
| CPU 普通 draw 编码 | 1204 | 4 |
| Bundle 执行 | 0 | 36 |
| Bundle 重建 | 0 | 0 |
| 上传次数 / 字节 | 32 / 194180 | 32 / 194180 |
| 新 GPU buffer / bind group | 0 / 0 | 0 / 0 |
| 热池 miss / owner residual | 0 / 0 | 0 / 0 |
| CPU 录制 ms | 19.981 | 10.623 |
| CPU 提交 ms | 0.066 | 0.066 |
| GPU render-pass ms | 0.202 | 0.188 |
| Queue wait ms | 8.831 | 5.408 |

原提交两个 cohort 的 CPU 录制中位数为 23.063 / 16.900 ms，bundle 为 11.990 / 9.255 ms。不同轮次的绝对时间波动明显，较早顺序采样还出现过 GPU 时间上升，保留于 `artifacts/webgpu/indirect-bundles-sequential-diagnostic.json`；不按其中最佳一轮推导性能结论。最终交错采样 source fingerprint 为 `sha256:dc01ea35e3362b2bcc4004ad94d9e1316578759cad7e7a39b2206fbaa18bd223`。

GPU timestamp 只统计四个 render pass，不包括 compute；队列等待单列，不能视为 GPU 时间。该夹具证明提交结构变化和当前机器的局部成本，不推导通用帧率提升。

## 验证状态

全仓 typecheck、test 通过：Shader Language 112、Engine 609、animation-spec 139、extensions 372、示例目录 7，共 1239 项。结构/缓存/生命周期聚焦测试 42 项通过。新 GPU 对照 10 项，以及辅助语义 17、TAA 25、统一输出 17 项均通过。

全仓核心 workspace 构建通过；示例构建限定 ambient-occlusion、taa-postprocess、motion-blur、outline-postprocess、normal-material、shader-language-lab、shader-language-character-material，共 7 个示例和 2 个共享目标，9 个 freshness 校验通过。没有执行全部示例构建。modules（443）、responsibilities、renderer-prepare、docs 和 diff whitespace 检查通过。

API 检查仍失败于已有 workspace graph、audio/simulation/GUI/animation 等基线差异，未更新基线。之前已记录的 shader 字节预算和 Animation2D shader-stage fixture 问题不属于本次修改，也没有通过全仓单元测试就宣称这些门禁已恢复。

额外运行旧 `real-renderer-scenario.test.mjs` 时，发现四项现存集成基线问题：缺少 games/pad-simulator 素材；统一输出使 batched 四视图 pass 期望 9 而实际 13、反射期望 25 而实际 45；旧 full-prepare fixture 仍使用非隔离 pass。这些测试走原 batched/HDR 路径，没有放宽断言或修改预算。

主要日志：`artifacts/gpu-bundle-types.log`、`gpu-bundle-tests-final.log`、`gpu-bundle-repository-build.log`、`gpu-bundle-focused.log`、`gpu-bundle-api.log` 及 `gpu-bundle-webgpu.log`。
