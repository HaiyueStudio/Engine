# ADR 0079：SceneBatch/WASM 仅以真实收益证据保留

- 状态：Accepted
- 日期：2026-08-16

## 决策

1. JS ECS 继续拥有 Entity/Component、父子关系和生命周期。候选 SceneBatch 只缓存连续派生数据与稳定 entity identity，不能成为第二套权威状态。
2. 先实现可独立验证的 TypeScript SoA oracle 与当前 object path 对照，再决定是否加入 WASM kernel。WASM 每帧/批只允许少量大颗粒调用，使用长期线性内存和 dirty range。
3. G07 在实现前冻结 workload：1k/10k/50k 层级 transform + sphere cull，固定 visible id、world matrix、depth key parity；记录同步、kernel、mapping、total CPU、allocation 和包/启动成本。
4. 保留阈值为 10k 与 50k workload 的端到端 CPU P50 均至少改善 20%，P95 不回退，输出逐实体一致，且 engine gzip 增量不超过 32 KiB。任一条件不满足则删除 WASM runtime，保留可复现 no-go 报告。
5. WASM 必须 optional、可 abort/dispose、支持 base path/CSP/packed consumer；加载失败走显式 diagnostic 后的 JS oracle。不得让 Engine 初始化依赖 WASM。
6. BVH、instance builder、archetype ECS 和 renderer threads 不属于本 Goal；threads 需要新的产品证据与 ADR。

## 后果

- 旧 todo 的 synthetic Node 数据只是候选基线，不是保留实现的依据。
- G07 可以以“验证后 no-go 且候选代码已删除”完成，不以代码量衡量优化。
