# ADR 0076：RenderGraph 计划、RenderPipeline 执行与参数化 Renderer Core

- 状态：Accepted
- 日期：2026-08-16
- 修订：ADR 0006、0037 的正向类型合同

## 决策

1. RenderGraph 是无设备的声明/计划编译器，拥有 dependency、read/write、reachability 与 logical resource lifetime；它不创建 WebGPU encoder、pass 或提交队列。
2. RenderPipeline 是执行器，消费有序 frame plan，拥有实际 target resolution、pass compatibility、encoder/pass lifecycle 与 submission；不得重新推导 RenderGraph 已决定的逻辑依赖。
3. Frame coordinator 只提取不可变 frame/view 输入，plan compiler 只产出 typed plan，submitter 只消费 plan 与 resource resolver。诊断快照由实际 compatibility/submission 决策产生。
4. Pass compatibility 比较实际 resource identity、color/depth attachment、load/store、sample count 与 required state；未知 target 不得视为相同。
5. 参数化 renderer core 拥有 object slot/table、geometry identity/cache、upload/retirement、material identity 与基础 pipeline key。具体 renderer 注入 shader family、material packer、pass policy 与特殊资源。
6. Renderer 逐批迁移，旧 owner 在同批 parity 通过后删除；禁止 facade 反向依赖、同步双写、无 owner 全局 cache 或万能 renderer。
7. Mutable scratch 必须绑定一次 record/view 调用并有 reset/reentrancy contract。透明 CPU/GPU path 共享一个深度量化策略。

## 验收

- 类型测试表达 frame → plan → submit 的单向数据流。
- target/load/store 冲突诊断与真实 pass 合并一致。
- renderer parity、upload count、多视图、RTT/mirror、destroy/recover 与真实 WebGPU fixture 通过。
