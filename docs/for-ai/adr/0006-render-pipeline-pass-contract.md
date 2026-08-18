# 0006：RenderPipeline pass 调度契约

- 状态：Accepted
- 日期：2026-07-10

## 背景

RenderPipeline 同时调度 render/compute entry，并支持 shared/isolated pass、target、load/store 和排序。共享 pass 可以降低 pass 切换，但如果系统自行结束 pass 或对 target/load/store 的理解不一致，后续 entry 会产生隐式行为。

## 决策

1. RenderPipeline 只负责排序、pass 生命周期、target 选择和 command submission，不承载具体 renderer 业务。
2. render system 通过 record contract 记录命令；shared entry 不拥有 pass 生命周期，不能自行结束由 pipeline 管理的 pass。
3. isolated entry 可以拥有独立 pass，但仍必须通过明确 context contract 创建和结束。
4. compute entry 会结束当前 render pass，执行后由后续 render entry 重新建立需要的 pass。
5. target 必须有稳定 key；color/depth load/store 和 depth presence 参与 pass compatibility 判断。
6. sort 决定逻辑顺序，registration order 只作为相同 sort 的稳定 tie-breaker。
7. diagnostics 启用时，pipeline 必须输出与实际执行一致的 debug snapshot，并对 shared pass 违规、target key 冲突和 load/store 冲突给出诊断。
8. diagnostics 关闭时，逐帧调度不构造 pass/issue trace、字符串 pass key 或 record callback；shared pass 使用字段直接比较，resource ownership 使用 enter/leave token。配置变更和实际 WebGPU command/context 创建不属于该零分配调度约束。

## 后果

- 阶段二会把低层 pipeline 控制移出 stable 默认入口。
- 阶段五按此契约拆分 RenderPipeline 与具体系统职责。
- 阶段七补齐 pass snapshot、实际合并结果与编辑器诊断面板。
- production 热路径只执行 pass 调度和 system record；详细 trace 必须由显式 diagnostics 开关承担成本。
