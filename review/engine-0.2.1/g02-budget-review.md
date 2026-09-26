# G02 Shader 与 Engine 包预算评审

日期：2026-09-25。状态：**用户确认后已应用预算配置**。
测量对象为 `61d40f7bf75e05ec948754d85fdbf70512a21ca8` 加当前 G02 工作区；不是 clean-release。
逐文件增量、候选阈值验证与 tarball SHA-256 见 [机器证据](./g02-budget-evidence.json)。

## 已采用的调整

按已实现能力的实际增量增加容量，保留既有储备。包字节数未超限，无需增加。

| 指标 | 当前测量 | 调整前上限 | 已采用上限 |
| --- | ---: | ---: | ---: |
| 全部生成 WGSL 字节 | 397,578 | 363,464 | **400,801** |
| WGSL 文件数 | 69 | 67 | **69** |
| variant / pipeline 数（各自） | 61 | 59 | **61** |
| Engine 包文件数 | 614 | 609 | **620** |
| Engine 压缩字节 | 1,913,174 | 2,100,000 | 不变 |
| Engine 展开字节 | 8,494,886 | 9,000,000 | 不变 |

WGSL 总量是所有生产生成文件的源码成本；不等于用户首次下载体积、单帧活跃 pipeline 数或 GPU 耗时。

## Shader 增量归因

相对 HEAD 的 360,241 B，当前净增 **37,337 B**：

- Deferred G-buffer：21,778 B。
- Deferred reference lighting：11,290 B。
- 四个现有 PBR 变体的共用表面采样及顶点颜色：每个 +756 B，共 +3,024 B。
- 深度、阴影、运动向量、轮廓和法线 pass 的一致顶点颜色/alpha coverage：共 +1,245 B。

总上限按 `363,464 + 37,337 = 400,801` 调整，继续保留原先 **3,223 B** 的余量。
只准入已生成的两个新 pass，因此文件/variant/pipeline 各增加 2；不提前为 G03/G04 或新材质组合保留名额。

已同步修改 `shader-language/shader-cost-budgets.json` 的 production 最大值和 maxGrowth：
字节增长额度为 **95,297**（400,801 − 305,504），其余三个增长额度均为 **5**。
历史 growthBaseline 保持 305,504 B / 64 文件 / 56 variant / 56 pipeline，不能通过重置基线隐藏增长。
showcase、10 秒冷生成上限、DAG 和三个既有 production bundle 上限保持不变。

若后续继续超限，先检查重复生成、重复静态变体和依赖引入，再为实测的新能力提交增量归因；本提案不一次性放宽到整个 0.2.1 的预估容量。

## 包增量归因

干净 Engine 构建后，两次 `npm pack --json --ignore-scripts` 的清单与 tarball SHA-256 完全相同。
上一次已审查 GPU 实例候选为 603 文件；当前新增 **11 个声明文件**，均在 tarball 中确认：Deferred profile、灯表及场景灯收集、顶点颜色、GPU 灯表、后端接口、能力探测、reference backend、PBR surface 接口、生成 ABI 和生成 artifact。

按 `609 + 11 = 620` 扩容；其中 reviewed.fileCount 从 602 增至 **613**，growthReserve.fileCount 仍为 **7**。
之前共享 chunk 已消耗的 1 个储备仍计入，当前候选可再容纳 6 个文件。
已同步更新 publicPackages Engine 与 legacy tarball 两处上限。packed/unpacked 容量和储备不变，当前分别剩余 186,826 B / 505,114 B。

Deferred 当前仍是私有实现。全包 JS 未发现 `deferred-gbuffer`、`deferred-reference`、Deferred compiler/artifact 标记；新增声明被现有 dist 白名单收录，不表示已有公开 Deferred 运行时入口。这里的标记扫描只是打包观察，不替代 consumer 闭包验证。
未来 G07 开放入口、引入运行时代码及 Shader 后，须重新测量真实 tarball 与独立 consumer，不能把当前 1.91 MB 当作最终 Deferred 发布体积。

## 提案阶段证据与边界

- `npm run build:engine` 干净构建通过。
- production cache verifier 完成生成一致性检查；实际预算检查仍按旧值失败。机器证据保留全部原始超限项。
- 用现有政策验证器在内存中代入本提案：当前 Shader 报告、Engine tarball 与 capacity 配置均通过。
- 对字节、文件、variant、pipeline 及包文件上限逐项模拟：等于上限通过，超出 1 拒绝；没有修改统计范围或验证器。
- 提案阶段没有重新运行全部已安装 consumer、完整 examples 或 GPU 发布门禁。配置落地后的验证另列如下；原始机器证据保留 proposed 状态，避免将先前的模拟结果写成正式验证。

其他库、root/focused consumer gzip 限额、公开 API、G01 CPU/GPU 性能预算均不调整。总包容量增加不应让默认入口或无关 consumer 引入新 Shader。
四视图偶发空输出仍按 [调查记录](./g02-four-view-investigation.md) 跟进；预算调整不解决该正确性问题，也不授予 G02/G07 完成或发布资格。

## 配置落地验证

用户已明确要求修改预算配置。针对性政策测试 17/17 通过，包含等于阈值通过、超出 1 拒绝及包字节限制保持独立的回归测试。

- `release:policy:test`：69/69 通过。
- `shader-language:check`：119/119 测试、typecheck、Stage 0/14 边界、生产生成一致性和实际成本预算全部通过；397,578 B / 69 文件 / 61 variant / 61 pipeline。
- `verify:engine-package`：四包确定性 repack、实际 npm install、29 个 browser consumer、Node、TypeScript、64 个 exports 导入、CLI 和 provenance 通过。
- Engine 包实测 1,913,174 B packed / 8,494,886 B unpacked / 614 文件；root golden path 为 48,221 B gzip（上限 60,000），GPU instances 为 80,329 B（上限 91,000）。
- `api:check` 通过；与原配置逐项对照确认其他三库、所有 consumer、Shader 历史基线、DAG 和生成耗时限制没有改变。

串行打包复核也已通过，最终证据无并发构建影响，Engine 包指标与提案实测完全一致。`docs:check` 与 `git diff --check` 通过。最终预算哈希、包哈希、消费指标和检查结果见 [落地验证摘要](./g02-budget-applied.json)。


## G02 closing bundle check (2026-09-26)

The full Stage14 DAG additionally found the deformation runtime artifact at 9,607 gzip bytes against its unchanged 9,600-byte cap. Lossless compact metadata generation reduces it to 7,983 bytes; exact runtime-artifact/compiled-artifact equality and the unchanged artifact hash are recorded in `artifacts/engine-0.2.1/g02/compact-deformation-equivalence.json`. WGSL and reflection are unchanged. No configuration or historical budget was expanded for this correction. Final acceptance is tracked by [G02 completion audit](g02-completion-audit.md).
