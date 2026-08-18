# ADR 0078：Compute、GUI 数据布局与资源合同

- 状态：Accepted
- 日期：2026-08-16

## 决策

1. Compute pass descriptor 显式声明 read、write、indirect use、dispatch 与先后约束；WebGPU command order 可以是实现机制，但调用方不能依赖未表达的隐式约定。
2. Shader stage flags 使用平台常量或 typed descriptor，禁止重复魔法数。pipeline/layout 等不可显式销毁的 WebGPU 对象由 device-scoped cache/owner 释放引用；buffer/texture 等可销毁资源保持幂等销毁和恢复。
3. Texture convolution 的格式、workgroup 与 storage access 从 Artifact V2 reflection/typed descriptor 派生；unsupported format 精确失败，不静默改写。
4. GUI shape/text/image 的 CPU packer 和 GPU vertex attribute 从一个 typed layout descriptor 派生，stride/offset 不平行手写。
5. GUI sampler 按 renderer/device 明确持有并在 destroy/recover 时释放引用；texture、buffer 与 bind group 的 owner 不因缓存而丢失。
6. GUI 持久化 payload 使用显式 format/version，对 unknown 输入校验并报告精确 path。0.1 前无历史项目迁移窗口，格式升级原子替换 fixture。

## 验收

- compute ordering validator、真实 storage→indirect fixture、GUI round-trip/invalid-input、layout parity 与 lifecycle residual 通过。
