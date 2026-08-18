# ADR 0074：0.1 发布候选前插入 Runtime Convergence

- 状态：Accepted
- 日期：2026-08-16

## 背景

M02 已冻结 0.1 公共面并完成当前 Windows 主机的发布演练与浏览器回归，但正式设备正确性证据仍未全部具备。此时继续把评审确认的 shader、render scheduling、renderer、Worker、compute 与 GUI 内部债带入首发，会把 0.1.x 兼容修复窗口变成底层重构窗口。

## 决策

1. M2.5 从“首发后”调整为“0.1 最终 RC 前”的内部收敛阶段；它消费 M02 已冻结的 API、格式、浏览器、性能和发布合同，但不依赖 M02 已发布。
2. M02 G07 的最终 go/no-go 在 M2.5 G08 完成后重新执行；M2.5 不替代 M02 的正式设备证据、发布制品检查或发布授权。
3. M2.5 默认保持 0.1 stable declaration、错误 code、数据格式和渲染结果兼容。需要公共或格式破坏时必须中止对应 Goal，另立 ADR，并在同一集成阶段完成全仓迁移。
4. M03 继续依赖 M2.5 完成。M2.5 只依赖 M01 和已经冻结的 M02 contract input，避免与 M02 形成依赖环。
5. M2.5 不准入 Markdown/MSDF、完整 shaping、音频、PointLight shadow、透明能力扩张、geometry streaming、renderer threads 或 WebGL2 fallback。

## 后果

- 0.1 最终候选会消费收敛后的 runtime 内部实现，但仍由 M02 发布门禁作最终裁决。
- 当前无法提供的正式设备证据继续是 M02 blocker，不会被架构测试或当前 GTX 1070 Ti 结果替代。
- M03 不与底层 runtime 收敛争用共享合同和实现文件。
