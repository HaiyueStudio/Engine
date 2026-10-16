# 运行时所有权约束

本表保留 M2.5 收敛后的职责边界。旧“当前 owner／待修复缺口／Goal”规划表已收入[原文归档](../../../review/archive/engine-process-history-20261016.json)，不再把完成前的问题描述为当前缺陷。

| 领域 | 唯一 owner 与保留约束 |
| --- | --- |
| Shader source、schema、target／cost | shader-language source、compiler validator 与生成器拥有 schema、WGSL／reflection 和 cost；engine 只消费生成合同，不自建另一套生产 writer 或 binding rewrite |
| 逻辑 pass 与实际执行 | 逻辑图／typed plan compiler 拥有依赖与瞬态生命周期；执行层解析真实 target 并按兼容状态执行，不能重复推导图关系 |
| Renderer object、geometry、upload 与退役 | 参数化 renderer core 拥有共享生命周期；特殊资源策略由能力 owner 注入；透明深度使用共享量化合同 |
| Renderer async 与 scratch | owner generation／abort 阻止迟到写回；scratch 按调用隔离，不能在多 view 间复用可变单例 |
| Worker transport、async primitive 与 asset phase | 共享的版本化 WorkerChannel／async helper 拥有通用协议、abort／priority／clock；AssetJob 经自身方法更新 phase，consumer 不绕过协议写内部状态 |
| Compute ordering 与 GPU resource | typed sequence／validator 表达资源依赖；device cache 与 processor 分别拥有缓存及可销毁 buffer／texture，不把不可销毁的 pipeline／layout 当成泄漏 |
| GUI layout、serialization 与 sampler | typed vertex descriptor 共享 stride／offset；版本化 schema 校验未知输入；sampler 由 renderer／device scope 管理 |
| Scene 数值批量路径 | JS object ECS 保持权威语义；派生后端必须满足当前准入与完整同步成本要求，历史 WASM no-go 见[阶段结论](../../../review/m025/README.md) |

## 依赖方向

shader-language 不进入 runtime；Engine 不依赖 extensions；extensions 仅消费声明的 focused package export。Renderer core、frame coordinator、plan compiler、submitter 和 resource owner 保持单向数据流。当前能力变化仍以对应后续 ADR 为准。
