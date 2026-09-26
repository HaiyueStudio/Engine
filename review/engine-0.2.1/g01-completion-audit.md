# G01 完成审计

日期：2026-09-25。G01 complete；合同、预算和全部本阶段必需检查已通过。原目标保持为“现状复核、架构合同和预算冻结”，不以当前实现范围替代。

| 原要求 | 权威证据与核对结论 |
| --- | --- |
| 复核来源并分类 | README 的 still-current / already-fixed / new-work / deferred 表；生产 runtime 与原观察点一致 |
| 材质、ABI、profile、owner、fallback、阴影/MSAA | ADR 0109 frozen；source/view 字段与偏移、generation/稳定 ID/索引、材质逐项 owner/case、pass 顺序、实验入口隔离、MSAA/特殊材质回退均已明确 |
| 两类设备及 owner | device-plan.json、adapters.json；AMD rdna-1 与 Intel gen-9，native、timestamp 可用；G01/G05/G07 的采集责任分别列出 |
| G-buffer limits、精度与带宽评估 | 两设备 gbuffer-probe.json 通过；ADR 记录实际 device limits 检查、误差阈值、B/pixel/读写 payload 和估算边界，不冒认完整场景性能 |
| Forward 与既有 GPU 实例基线 | frozen-baseline 完整 30 项，固定输入、300 CPU/300 GPU ×3、原始样本全部保留、60 次主机限制 100；g01-baseline-summary.json 绑定文件哈希 |
| 稳定性与预算冻结 | 8/10 组合相对稳定；用户明确批准另两项具名绝对上限，仍保留 stable=false；配置 frozen、设备 CPU/GPU/frameWall 及 E/F 每项数值齐全，--require-frozen 通过 |
| 固定案例/seed、精度、内存、包体/Shader 方法 | 机器配置 A–G；ADR 固定房间、PRNG/灯光/相机/材质、720p/1080p/四完整视图，既有包体预算不提高，新增成本由 G07 逐入口评审 |
| 上游 commit/hash/license | upstream-reference.json，官方固定 commit、五个文件 SHA-256、BSD-3-Clause；本轮未复制代码/模型 |
| 实验入口、实际消费版本、独立发布线 | ADR 中现有 experimental/renderer 的异步工厂/backend port 设计；consumer-versions.json 哈希复核；协调仓 producerCandidates.Engine；不升级消费依赖或依赖 UI 发布 |
| 采样与统计验证 | G01 policy/host 测试含缺样、假 GPU、设备/工作量错配、NaN、负计数、指纹、主机限速、相对波动、具名上限超限和冻结文件篡改拒绝 |
| 必需检查 | G01 policy/host 16/16、lighting 30/30、performance-budget:test 122/122；docs:check、api:check、协调仓 check、--require-frozen 与 diff whitespace 检查均通过；最终日志在 artifacts/engine-0.2.1/g01/ |

## 范围与交接

冻结的是设计和 G01 校准预算，不是 Deferred 已实现、帧率已达成或发布资格。G02 实现全灯参考，G03 Tiled，G04 兼容，G05 完整设备性能，G06 示例，G07 clean candidate 与独立 Engine 门禁。已有 Forward+/CSM hold 保持，稳定 root/API 和包版本未改。

G01 旧 Forward 的 128 灯场景仍受 8 灯上限截断，不参与未来完整 128 灯的等工作量加速比。现有实例基线只测静态外部矩阵 + LOD/indirect，不能外推动态模拟、LOD 画质收益或完整 F 组；其 CPU record 也不替代后续 CPU prepare+record+submit。

## 阻塞与恢复历史

原三轮 Goal 工作因设备稳定性前置条件未满足而 blocked，保留原始失败数据。恢复时主机限制为 100；第三次采样中途再次限速并按门禁停止。第四次在统一场景间空闲下完成三轮，原始样本未删改；用户随后确认两项微小时延的具名绝对上限。所有失败与恢复过程见 README 和对应归档，旧波动没有被改写为历史通过。
