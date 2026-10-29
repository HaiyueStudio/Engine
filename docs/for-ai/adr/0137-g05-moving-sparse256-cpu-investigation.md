# ADR 0137：0.2.2 动态 sparse-256 CPU 子预算作为调查项

- 状态：接受；2026-10-29 用户明确批准“仅将 G05 动态 sparse-256 的 CPU 4 ms 线改为调查项；保留原失败、全部样本和预热口径”。
- 范围：0.2.2 的 Windows Chrome／Edge，G05 rooms、moving=true、algorithm=tiled、caseId=sparse-256、cpuP95Ms、limit=4。0.2.1 的解释保持。

## 问题与结论

干净 e9f257b 的完整 156 次房间捕获中，Chrome 动态 sparse-256 CPU pooled P95 为 4.10 ms，超过原 4 ms；该场景 GPU P95 0.62 ms、离屏整帧 P95 7.84 ms 通过。房间其他 59 项性能检查及全部资源检查通过。离屏整帧不是呈现 FPS，完整生产帧节奏仍须单独通过。

仅将上述 CPU 子预算超线列为调查，不单独阻止 0.2.2 的 G05 前置资格。原报告仍为 failed，4 ms、observed、passed=false 及全部原始捕获保持；新解释单列 cpuAbsoluteInvestigations。此结论不认定超线全部是噪声，也不认定 JIT、频率或调度为首因。

## 实施与边界

1. 只改验收解释层及其测试。冻结预算、采样器、CPU／GPU 各 120 帧预热、三轮各 300 CPU／300 GPU 样本、顺序、冷启动、全部样本和运行时均不变；不丢慢帧，不重试择优，不采用 360 帧诊断口径。
2. 双浏览器的具名 CPU 检查均须完整存在，保留原数值与原判定一致性。静态 sparse-256、其他灯数／算法／浏览器、其他 CPU 指标与阈值、GPU、整帧、cull 比例、内存、画质、冷启动和生产帧节奏要求保持原硬门禁；Forward CPU 5% 继续仅按 ADR 0127 处理。
3. 早期 G13 检查和七报告原始审计都使用明确的 0.2.2 目标；默认 0.2.1 仍拒绝该 CPU 绝对超线。原始失败不能被改成 passed，缺项、非法数值、伪造判定或任何其他硬失败仍阻断。
4. 继承 ADR 0126 的严格哈希复核：除其原有具名验收文件和 Markdown 文档外，0.2.2 仅增加 scripts/g13-windows-final-policy.mjs、scripts/g13-windows-final-policy.test.mjs 和 review/engine-0.2.2/g13-checks.json 三份解释／索引文件。仍须 Git 比较、完整原始捕获及当前配置／采样输入一致，并在最终七报告验收时重建、逐字节对照可执行块。运行时、采样器、锁文件或数值预算变化不在此范围内。
5. 采样提交与验收提交分别记录。现有报告的限定复核只授予 G05 前置解释，不授予完整 G13、Apple、发布或基线晋升资格。剩余组、完整全局门禁和无发布演练仍须完成。

当前状态与原始证据见 [G13 验收结论](../../../review/engine-0.2.2/README.md#g13-包集成与发布候选)及[验收索引](../../../review/engine-0.2.2/g13-checks.json)。
