# 0.2.0 冻结候选全局验收

2026-09-24：在现有冻结候选上完整执行原始 `npm run release:check`，**全局通过**。本次单一进程链路退出码为 0，并输出 `Global release candidate gate passed.`。执行时间为 UTC 05:16:15–06:32:08（北京时间 13:16:15–14:32:08），耗时 75 分 53 秒。

冻结 revision：`3639ab0601306dc40601dc6ac9c0e3516f8a6ec8`；tree：`d34ac0db736f5d42e9b4fb146e3ebb9a447bb690`。执行前、执行后及归档复核均为同一 revision、`dirty=false`。未修改候选源码、放宽超时或预算、更新画面基线。原工作区只更新评审记录与证据；没有创建发布 tag、push、publish、签名或部署。

本次证据目录：[0.2.0-global-rerun-20260924](../artifacts/release/0.2.0-global-rerun-20260924/)。包含 [完整日志](../artifacts/release/0.2.0-global-rerun-20260924/release-check.log)、[执行记录](../artifacts/release/0.2.0-global-rerun-20260924/invocation.json)、[机器汇总](../artifacts/release/0.2.0-global-rerun-20260924/verification-summary.json) 及 `SHA256SUMS`。38 个本次新生成的原始报告、截图和 npm 包已复制归档，并逐字节确认与候选输出一致。

## 执行与覆盖

使用 `WEBGPU_REQUIRE_NATIVE=1`、`BENCHMARK_PROFILE=full` 和官方 npm registry，未筛选用例。环境为 Mac Chrome 153.0.8010.53 / 原生 Metal / AMD Radeon Pro 5300M，符合矩阵中的 macOS 完整资格路径。不据此宣称 Windows、Safari 或 Android 已验收。

同一个全局进程依次完成以下全部阶段：

| 阶段 | 本次结果 |
| --- | --- |
| 正式灯光与独立证据校验 | 128 个局部灯、全动态、高重叠、4 视图、720p；原生 GPU，同一清洁 revision |
| fast 门禁 | 四库 1278 项、示例 7 项、性能策略 122 项、发布策略 65 项；类型、API、文档、架构、Shader 成本与发布范围检查通过 |
| full slow：渲染正确性 | glTF 三档、AO、clipping/navmesh、PBR、雾、Volume、基础/产品像素、4 组产品截图等检查通过 |
| full slow：AO GPU 成本 | full 模式 18 个用例，8 次预热、30 次采样；产物及 WebGPU 校验通过，固定设备耗时预算仍为 diagnostic-only / not-enrolled |
| full slow：Shader Stage 14 | 25 个 DAG 节点完成，Shader 成本预算通过 |
| full slow：完整示例 | 55 个自动示例（46 smoke / 9 full）；含 shared Engine 共 56 个新鲜目标，源码指纹前缀 `fc136d3ae4cc` |
| full slow：CPU 基准 | full 模式 93 个用例，8 次预热、30 次采样、10 次迭代；保留 4 项 report-only 耗时告警，结构指标违规为 0 |
| 长 readback | 1800 帧、约 30 秒、450 次 churn、创建 4220 个资源，最终残留 0；延迟 P95 为 0 帧，skipped 比例 3.08% |
| 四包 release 验证 | 四个 0.2.0 npm 包、确定性打包、独立安装、28 个消费端、Node / TypeScript / 公开导出 / CLI 检查通过 |
| 入口预算 | Release matrix byte budget passed |
| 正式跨引擎比较 | full / enforce / formal，策略通过，无违规 |

manual 示例集合仍遵循原 manifest，不属于自动执行范围。没有 revision 字段的旧式报告由干净候选、执行日志、文件生成时间及归档哈希绑定，没有改写原报告补造字段。

整个 `review/baselines` 目录执行前后及归档复核的 SHA-256 均为 `11ea61ebd51ddf6b6e21d1cd02c01083c3547c47f7ef4e29cffd9c9f521eeee0`。算法按路径排序，依次输入相对仓库根目录的 `路径 + NUL + 文件内容 + NUL`。

## 本次正式性能结果

固定 `pbr-grid-v1` 场景，1280×720、256 个盒子、8 个材质，无阴影；3 个 cohort，每轮预热 12 帧、正式采样 40 帧。每个排名引擎保留 120 个样本，均为 AMD 原生 WebGPU。`frameWall` 包括提交与等待队列完成，不是纯 GPU timestamp。

| 引擎 | frameWall P50 | frameWall P95 |
| --- | ---: | ---: |
| HaiYue 0.2.0 | 1.685 ms | 2.225 ms |
| Three.js 0.185.1 | 1.920 ms | 2.900 ms |
| Babylon.js 9.21.2 | 2.160 ms | 2.970 ms |
| PlayCanvas 2.21.4 | 2.740 ms | 3.550 ms |

HaiYue 最慢 cohort P50 为 1.715 ms，竞品最快 cohort P50 为 1.870 ms；现有策略通过。Galacean WebGL2 仅作信息记录，不进入 WebGPU 排名。本结果只适用于该场景和环境，不代表所有项目的性能或画质等价。

[本次正式原始报告](../artifacts/release/0.2.0-global-rerun-20260924/evidence/artifacts/performance-comparison/formal.json)。

## 保留的诊断与发布边界

CPU 基准仍按原有 `report-only` 策略运行，报告中的 `budgetStatus` 为 `budget-exceeded`，不能写成所有耗时预算通过：

| CPU 用例 | 实测 P95 | 诊断预算 |
| --- | ---: | ---: |
| glTF parse 2000 | 2.751 ms | 1 ms |
| Spine parse 800 | 2.019 ms | 1 ms |
| PBR material prepare 4000 | 3.624 ms | 2 ms |
| capability negotiation 4000 | 8.366 ms | 6 ms |

CPU 相对比较为 `ineligible / baseline-missing`，未生成可用于宣称无回退的固定 runner 基线。Mac 原生 GPU 固定设备耗时预算也保持 `not-enrolled`；这与已通过的正式跨引擎比较分开记录。未提升基线或改变任何预算来取得绿色结果。

[同版本供应链与无发布演练](release-0.2.0-formal-readiness.md) 的此前证据继续有效，但本次 `release:check` 没有重新执行供应链审计。此前生产审计无漏洞；开发工具链保留 3 个 high 条目，具体隔离范围见该记录。

“完整全局门禁未通过”的阻塞已关闭。本记录证明当前冻结候选通过现有 macOS 发布资格路径，不代表版本已经发布；正式发布操作尚未执行。

## 历史失败记录

此前三次尝试及补充正确性检查保留在 [旧归档](../artifacts/release/0.2.0-global-check/)；[原评审全文快照](../artifacts/release/0.2.0-global-rerun-20260924/previous-global-check-review.md) 也已保留。

首次尝试缺少扩展声明，由仓库已有 bootstrap 补齐。随后两次完整重跑分别在 AO shared build 与 shadow-map 构建触发原有 60 秒超时，现场观察到其他 Games 并发测试占用多个 CPU 核心。此次使用相同冻结 revision 和原超时完整跑通；历史失败不改写为成功，也没有将多次失败的分项拼成全局通过。
