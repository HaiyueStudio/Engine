# ADR 0066：大型能力采用真实产品证据准入

- 状态：Accepted
- 日期：2026-08-01

## 背景

Forward+/Clustered、CSM、WebGL2 fallback、分层 Polygon NavMesh 以及 clipping cap/专用 renderer 裁剪都不是局部 feature。它们会扩大 Shader、pipeline、资源布局、恢复、编辑器诊断、浏览器兼容和长期测试矩阵。当前引擎已经有对应的明确边界，但这些边界此前分散在评审和多个 ADR 中，除 lighting 外没有统一机器门禁。

单纯看到固定容量、示例缺少某个效果或 synthetic benchmark 达到上限，并不能证明真实产品需要承担这类复杂度。相反，完全依赖评审文字也容易在持续迭代中被遗忘。

## 决策

1. 大型能力默认状态为 `hold`；只有真实产品证据完整时才可改为 `prototype-approved`。
2. Forward+/Clustered 和 CSM 继续由既有 `lighting-architecture-policy.json` 专项 evaluator 管理，统一 checker 只聚合结果，不复制其指标。
3. WebGL2 fallback、分层 NavMesh 和四种裁剪扩展由 `capability-admission-policy.json` 独立管理。
4. 每种裁剪扩展分别提供 evidence；caps、instanced、line 与 planar mirror 不能相互解锁。
5. 所有证据必须包含真实内容来源、固定 replay 或 reference、可验证 provenance、当前路径 deficit、设备类别和零未分类失败。
6. `eligible-for-prototype` 只允许启动受控原型，不等于产品采用或稳定 API。产品采用需要原型后的独立 ADR、性能/正确性/设备证据与迁移计划。
7. `check:fast` 必须执行统一 admission checker，local/global release 自动继承；不能只保留一组不会消费当前 policy 的单元测试。

## 当前结论

- 128-light fixture 只证明固定 8-light cap 被观察到，没有真实同画面产品需求，因此 Forward+/Clustered 保持 hold。
- 当前没有长视距室外产品 deficit，CSM 保持 hold。
- GLSL ES 300 只证明 Shader IR backend 可行性，没有覆盖率需求和完整运行时 parity，WebGL2 fallback 保持 hold。
- 地面洞口已由单层 NavMesh 的局部表面采样解决，没有重叠可走表面需求，分层 NavMesh 保持 hold。
- Mesh3D 多平面片元裁剪已满足当前剖切示例；没有闭合 cap、大规模实例、线段或反射视图的真实阻塞证据，四种裁剪扩展保持 hold。

## 后果

- 不会为了宣称能力完整而提前增加大型后端。
- 一旦真实需求出现，证据 schema、最小工作量和批准路径已经明确，无需重新争论“是否算真实需求”。
- policy decision 与登记 evidence 不同步会阻断 fast/release gate；实现仍须由 ADR、API 和架构评审共同约束。
- 若未来改变证据口径，需要升级 schema 或新增 ADR，不能通过降低阈值或把失败改为未分类来放行。
