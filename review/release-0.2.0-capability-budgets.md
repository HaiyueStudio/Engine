# 0.2.0 能力与预算评审

日期：2026-09-23。用户确认五组能力全部进入本次发布，版本采用 0.2.0。
决策见 [ADR 0106](../docs/for-ai/adr/0106-release-0.2.0-capability-budgets.md)。
这是本地候选评审，不是正式 clean-runner 发布结论。

## 范围与 API

| 能力 | 入口 | 审查后的入口符号数 | 稳定性 |
| --- | --- | ---: | --- |
| 音频混音 | engine `/experimental/audio` | 5 | experimental |
| 多玩家输入 | engine `/experimental/simulation` | 34 | experimental |
| GUI 字体 | engine `/gui` | 84 | stable |
| 字体图集 | engine `/font` | 13，未增加 | stable |
| 动画文本样式 | animation-spec 根入口 | 95 | stable |
| 动画交互 | extensions `/animation` | 33 | stable |
| 虚拟摇杆 | extensions `/controls` | 9 | stable |

Engine `/experimental` 聚合计数刷新为 846；根入口仍精确为 30 个符号。
API reviewed count 与旧 baseline 数量不同：旧能力预算已有部分储备或预分配，不能把两者的差额当作本次新增 API 数。
本次实际 baseline diff 是 28 个导出条目（含聚合重复），没有删除导出。
已存在于 baseline 的摇杆入口继续纳入。各组增长比例和最小储备保持不变。

## 测量方法与归因

先在原预算下重新构建和验证，复现四项体积失败，再新增能力 fixture 并测量。
四包均以 dist-only npm tarball 做确定性重复打包、真实离线缓存安装及 Rollup 消费端检查；
消费端指标沿用 ES 输出、inlineDynamicImports、gzip level 9，未引入 minify 或改变测量人口。
Node、TypeScript、64 个 export target 和 CLI 消费验证通过。

源码级对照使用相同入口、相同构建设置，仅把 `opentype.js` 替换成抛错 stub，测量字体解析器的边际成本。
stub 构建不能运行，仅用于诊断，未进入源代码、npm 包或正式 gate。
不能直接拦截 dist 中的 opentype import：该库已被内联到共享 chunk，必须比较配对的源码构建。

| 配对源码测量 | 完整 gzip | 移除字体解析器 gzip | 边际成本 |
| --- | ---: | ---: | ---: |
| Animation2D | 223,172 B | 125,510 B | 97,662 B |
| HYA 状态机 | 231,125 B | 133,448 B | 97,677 B |

完整文本需要解析真实字体轮廓。此次明确纳入字体能力，接受当前同步静态依赖产生的约 98 KB gzip 成本。
它也使无文本的 Animation2D 调用方承担下载成本，这是本候选的已知取舍；以后可单独设计可选文本适配器。
去掉解析器后仍比旧 120/130 KB 消费预算略高，故不能将全部增长简单归咎于第三方库。
交互和摇杆独立消费检查证明没有携带完整动画文本路径；仅 GUI 字体选项的类型导出不产生 JavaScript 成本。

## 预算调整

单位均为 bytes，不是 KiB；消费端为 gzip。

| 项目 | 0.2.0 实测 | 原上限 | 新上限 | 新余量 |
| --- | ---: | ---: | ---: | ---: |
| animation-spec 压缩包 | 130,279 | 125,000 | 145,000 | 14,721（11.3%） |
| extensions 解包体积 | 2,651,601 | 2,500,000 | 3,000,000 | 348,399（13.1%） |
| Animation2D 消费端 | 223,060 | 120,000 | 245,000 | 21,940（9.8%） |
| HYA 状态机消费端 | 230,623 | 130,000 | 255,000 | 24,377（10.6%） |
| 混音消费端 | 2,961 | 新增 | 4,000 | 1,039 |
| 多玩家输入消费端 | 4,077 | 新增 | 6,000 | 1,923 |
| 字体图集生成消费端 | 1,347 | 新增 | 2,000 | 653 |
| GUI 字体所在 GuiSystem 消费端 | 47,783 | 新增 | 55,000 | 7,217 |
| 动画交互消费端 | 49,181 | 新增 | 55,000 | 5,819 |
| 虚拟摇杆消费端 | 39,060 | 新增 | 45,000 | 5,940 |

包容量表示完整准入能力集合，包括 HYA 文本的声明、schema、codec、验证及交互/摇杆运行时；
不把总压缩包与单个功能的 gzip 差额作可加和估算。容量取当前实测加约 10–13% 的受限储备，
小入口按 1–2 KB 绝对余量取整，独立消费端预算防止总容量掩盖错误聚合。
animation-spec 解包 502,980/550,000 B、48/50 文件仍用原上限。
extensions 压缩包 513,428/550,000 B、188/200 文件仍用原上限。
Engine 总包上限不变：1,874,952/2,100,000 B 压缩、8,362,294/9,000,000 B 解包、593/600 文件。
根消费端仍为 48,221/60,000 B。Shader Language 的容量基线和限制均不调整。

## 可复现证据

- [紧凑测量记录](api/0.2.0-capability-evidence.json)：版本、revision/dirty 标识、tarball hash、消费端和类型验证。
- [诊断脚本](api/measure-0.2.0-capabilities.mjs)：`node review/api/measure-0.2.0-capabilities.mjs`，输出带输入哈希的 `artifacts/release/0.2.0-capability-cost.json`。
- `node scripts/verify-engine-package.mjs`：四包重新构建/打包、安装、28 个消费端以及运行时验证，输出 `artifacts/release/public-packages.json`。
- `npm run api:check`、`npm run release:scope:check`：当前 API / manifest 验证。

## 验证与剩余边界

已通过：0.2.0 四包及 28 个消费端验证、API / scope / 无 Rive 检查、全仓 typecheck、文档检查、
42 项对应能力专项测试、33 项发布策略测试。四个 workspace 与 catalog 合计 1,284 项测试通过
（Shader Language 112、Engine 666、animation-spec 107、extensions 392、catalog 7）。
初次全仓测试与另一个 scope 构建并行清理了 dist，导致 extensions 模块缺失；停止并行构建后，
顺序重跑完整 extensions suite 和 catalog 通过，不将首次失败计为产品回归。

性能策略重跑为 114/115，唯一剩余失败是缺少 `artifacts/webgpu/lighting-scaling.json`。
沙箱中的两项临时本地服务器测试遇到 EPERM，允许 loopback 后复核通过。
Shader 生产检查重新复现三项超限：总量 356,696 > 328,000 B，增量 51,192 > 22,500 B，文件增量 2 > 1。
完整 `npm run build` 已完成四个库、shared Engine、source viewer 和前 9 个示例构建，
包括之前超时的 `live2d-hya`；在 `bvh-lod` 构建期间主动停止额外全量检查（SIGTERM），未声称 92 个示例全通过。
本轮没有复现之前的 60 秒超时，不能把旧报告中的超时继续当作本次已确认的失败。

额外核对 shader 历史：相对预算配置引入提交 `ac31e7c` 的生成文件，新增的两份 WGSL 是
indexed-sprite 与 postprocess-output；其他显著增长分布在 normal-material、motion-vector、TAA 和变形 shadow。
该提交的 WGSL 文件总量为 327,019 B，和 policy 中更早的 305,504 B growth baseline 不同，不能混作同一基线。
因此没有依据把全部 Shader 增长额度计入本次五组能力，原预算继续保留。

本次不改变 Shader WGSL 成本、CPU/GPU 时延、灯光、设备或跨引擎比较预算。
已有 WGSL 356,696/328,000 B 超限仍需另行归因；完整 examples、真实设备矩阵、供应链和发布演练也仍需通过。
工作区尚未提交，这些本地结果不能代替同一 frozen clean revision 的正式发布验证。

后续 Shader 超限与 Mac 正式灯光证据处理见[专项评审](release-0.2.0-shader-lighting.md)；以上保留本阶段实测状态。
