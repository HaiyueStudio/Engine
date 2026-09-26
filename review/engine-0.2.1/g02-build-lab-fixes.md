# G02 全量示例构建与 Lab 像素差异修复

日期：2026-09-25。工作区：`release/0.2.1` 的 G02 开发候选；不是 clean-release。

## 示例构建

原构建器逐个启动 Rollup，但每个目标都使用 `@rollup/plugin-typescript` 和包含全部示例的 tsconfig。因此编译器会重复分析、生成整个项目；独立子进程无法复用这部分工作。之前全量构建在第 23 个示例 `physics3d-joints` 触发 60 秒超时；其独立重试为 44.1 秒，Lab 的诊断构建为 83.3 秒。

构建入口现在先对完整 examples 和 shared Engine 项目分别做一次无输出类型检查，任何诊断都会阻止后续生成。通过后，逐目标 Rollup 只转译实际遍历到的 TypeScript 模块，仍使用共享 worker/WGSL/包解析规则。完整项目检查覆盖未被当前目标引用的示例；没有改成只检查选中的示例。直接 Rollup 和 watch 继续使用原有类型检查插件。

默认每目标 60 秒超时、93 个 manifest 示例、共享 Engine、source viewer、独立进程退出检查、source fingerprint 与产物字节检查均保留。没有自动重试成功即掩盖第一次失败，也没有提高超时。

首次修复后定向测量：shared Engine 21.1 秒、`physics3d-joints` 1.1 秒、Lab 3.1 秒（Rollup 报告耗时；完整类型检查另计）。这是本机观察，不能直接视作 CI 性能预算。

新增行为测试验证：未引用示例中的语义错误仍失败；实际 bundle 只访问可达模块，跨模块 const enum 的运行结果和 source map 保持有效。测试接入 `fast-gate-policy:test`；17 项通过，独立 Rollup runner 的超时、非零退出、进程清理等 8 项测试也通过。

## Lab 差异定位

修改前在本机 Chrome 153 / Metal 复现最大通道差 **190**、平均差 **0.016298**，147,456 个像素中仅 **4 个**超过原容差 2。最差位置 `(196, 235)`：WGSL `[51,123,7,255]`，GLSL `[1,166,197,255]`。诊断保留差异坐标、两端颜色和超差像素数。

同一生成 Shader、纹理、uniform 和分辨率的独立对照：

| 采样方式 | GLSL sampler | 最大通道差 | 超差像素 |
| --- | --- | ---: | ---: |
| nearest | 默认精度 | 190 | 4 |
| nearest | highp | 190 | 4 |
| linear | 默认精度 | 1 | 0 |
| linear | highp | 1 | 0 |

这将当前失败定位到高频纹理的最近邻采样跳变：畸变坐标位于 texel 边界附近时，两后端可能选取相邻但颜色相差很大的 texel。提高 sampler 精度没有消除它。本轮没有判定某个驱动违反规范，也没有修改 GLSL 编译器或 Shader 数学来强求跨后端浮点逐位一致。

Lab 是连续波形畸变预览，现改用两端一致的线性 min/mag 过滤；repeat 寻址、纹理内容、全部像素统计、最大差 ≤2 与平均差 ≤0.25 的限制均保留。结果显示相邻 texel 的平滑过渡，不再存在原来的硬色块采样边界。该调整仅属于 Lab 预览，不改变 Engine 材质的采样设置或承诺 nearest 的逐像素可移植性。

## 浏览器回归

默认场景最大差 2，平均差 0.015613，超差像素 0。另增加四组确定性参数：无畸变、正向波形、负向波形和 repeat 接缝；全部最大差 1，平均差 <0.018。验证器逐项确认案例名称和数量，保留原有 PBR、19 关节角色五 pass、上传复用及导航中销毁检查。编译、验证和未分类浏览器错误均为 0。

初始原始证据在 `artifacts/engine-0.2.1/g02/build-lab-fix/`：`lab-before.log`、`sampling-probe.json`、对应探测源码/Shader 和 `lab-after.json`。最终全量构建后的 Lab 重跑同样通过，结果见 `lab-final.json`。

## 最终验证

- 默认、未过滤的 `npm run build` 完整通过；93 个示例 + shared Engine + source viewer 共 95 个目标。
- 全量类型检查集中耗时 52.5 秒；shared Engine 26.3 秒，physics3d-joints 1.2 秒，Lab 3.8 秒，最慢示例 lottie-hya-compare 6.9 秒。均为本次日志报告值。
- `npm run freshness:check -w ./examples` 和仓库测试后的再次独立复核均通过：95 个目标匹配当前源码指纹。
- 最终全量构建的 Lab bundle 在 Chrome 153 / Metal 通过默认及四个附加场景，原有角色/PBR/销毁检查通过。canonical、WGSL composition 和 GLSL backend 三个 Shader hash 与失败时一致。
- 仓库级 `npm run typecheck`、`npm test` 均通过，测试共 1,332 项（119 Shader Language、707 Engine、107 animation-spec、392 extensions、7 catalog）。
- fast-gate policy 17/17、Rollup runner 8/8、API、文档和 diff 检查通过。

源码/产物哈希、全部示例耗时、最终像素指标和验证结果见 [机器摘要](./g02-build-lab-validation.json)。本轮未提高超时、像素容差或性能预算。
四视图偶发空输出和动态灯 bind-group 偶发断言不属于这两个修复，继续保留在 [G02 调查](./g02-four-view-investigation.md) 中。
