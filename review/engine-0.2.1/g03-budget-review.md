# G03 Shader 增量预算提案

状态：用户已确认，配置已应用，完整门禁通过。日期：2026-09-26。[应用记录](g03-budget-application.json)保留批准内容、前后配置和带哈希的检查证据；原始机器提案保留提案状态。

新能力为每视图 16×16 分块灯光剔除和同帧完整灯表回退。两个 pass 分别需要 compute storage 写入和 fragment storage 读取布局，不能与既有完整灯表参考合并成同一个 pipeline。参考路径独立保留为正确性 oracle；高重叠自动旁路仍使用 Tiled resolve 的完整灯表分支。Tiled resolve 保留原参考的全局项与表面语义，点光源项按相同公式提取循环不变量，并经扩展 GPU 像素矩阵验证；生成后的自包含 WGSL 仍计入成本，没有排除重复源码或改变统计人口。

| 指标 | 当前实测 | 现有上限 | 提案上限 |
| --- | ---: | ---: | ---: |
| WGSL 总字节 | 417,394 | 400,801 | 418,480 |
| WGSL 文件数 | 71 | 69 | 71 |
| variant / pipeline 数（各自） | 63 | 61 | 63 |

G02 最终成本为 397,427 B；新 compute 为 5,041 B、新 Tiled resolve 为 14,926 B，合计 **19,967 B**。仍采用先前提出的 17,679 B 扩容量，不再次提高提案上限；点光源热循环优化新增的 2,288 B 使用原有储备，剩余 **1,086 B**。历史 growthBaseline 不变；maxGrowth 字节对应 112,976，文件/variant/pipeline 对应 7。冷生成、showcase、既有 bundle 和 CPU/GPU 性能预算不变。

实际 npm 包及 consumer 门禁全部通过：Engine 1,895,285 B packed、8,286,100 B unpacked、619 文件，仍在 2,100,000 / 9,000,000 / 620 上限内；默认 root consumer 48,221 B gzip，与 G02 一致。因此不建议调整任何包预算。Deferred 仍是私有入口，未来 G07 公开运行时入口后的成本须重新测量。

[机器提案](g03-budget-proposal.json)记录文件 SHA-256、原/拟定配置以及使用现有验证器的内存模拟。四项指标均验证等于上限通过、超过 1 拒绝。初始成本失败报告和包验证归档在 `artifacts/engine-0.2.1/g03/cost-review/`。本提案不授予性能资格或发布资格。

点光优化后的成本报告与此前预算提案副本位于 `artifacts/engine-0.2.1/g03/point-checks/`。用户确认后已严格按提案修改 production 绝对上限及对应 maxGrowth；历史基线、统计范围、包体与性能预算保持不变。

应用后验证：10 项预算策略测试、完整 `shader-language:check` 和完整 Stage14 DAG 的 25 个节点均通过。四项指标分别验证等于新上限通过、超过 1 拒绝；增长额度同时保持约束。日志和报告归档在 `artifacts/engine-0.2.1/g03/approved-budget/`。预算调整没有改变 runtime/harness 指纹，不豁免既有两项稳定性失败。
