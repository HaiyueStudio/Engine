# ADR 0084：Ray tracing 使用可卸载的 WebGPU compute extension

- 状态：Accepted
- 日期：2026-08-19
- 影响范围：M04、Extensions、Shader Artifact V2、RenderPlan、GPU/Worker 生命周期

## 背景

当前 WebGPU 标准没有 portable ray-tracing pipeline 或 acceleration-structure API。HaiYue 的 raster、
shadow map、planar/environment reflection 和 screen-space AO 路径仍是默认渲染事实，但它们无法天然
表达离屏遮挡物、任意动态反射或多次间接光传输。与此同时，ray tracing 会引入场景提取、BLAS/TLAS、
大规模 storage resource、compute shader、渐进 history、Worker 和 device recovery 等长期成本，不能在
缺少产品证据时进入 Engine golden path。

## 决策

1. M04 唯一后端是标准 WebGPU compute、storage buffer 和 storage texture 上的软件遍历。不得使用浏览器
   私有硬件 RT 扩展，也不得把 CPU 同步 fallback 表示成 GPU 成功帧。
2. 完整能力属于 focused experimental `@haiyue/extensions/ray-tracing`，保持 lazy load/unload；
   `@haiyue/engine` 根入口、默认 raster renderer 和无关产品 bundle 不聚合它。只有多个真实 consumer
   证明需要时，来源无关的最小协议才可通过独立 API review 进入 Engine focused subpath。
3. Scene、Transform、Geometry、Material、Light 和 Camera 是唯一事实源。Ray scene、packed material、
   BLAS/TLAS 和 GPU layout 都是按 revision 可重建的只读派生数据，不接受反向写入。
4. CPU oracle 先冻结 observable hit semantics；随后冻结 BLAS/TLAS packed ABI。GPU traversal 必须对固定
   corpus 与 oracle 一致，并结构化报告 unsupported limits、invalid geometry、stack overflow 和 mismatch。
5. 所有 production shader 由 Shader Language 生成 Artifact V2；runtime 不拼接 WGSL ABI。Compute pass
   通过现有 RenderPlan 声明 upload、traversal、shading、denoise 与 composite 的 read/write ordering。
6. Scene/project/extension owner 管理 snapshot、Worker queue、GPU buffer/texture、history 和 readback。
   Abort、dispose 和 recover 幂等；late/stale Worker 或 GPU 结果不得跨 owner/revision 写回。
7. Path tracing、ray shadow、ray reflection 和 ray AO 使用独立 admission case、options、diagnostics 和证据。
   一个效果的 reference 或性能结果不批准另一个效果。
8. 本 ADR 只冻结获准原型必须遵守的架构，不批准实现。`config/capability-admission-policy.json` 保持
   `hold`，直到登记 evidence 被 evaluator 判定为 `eligible-for-prototype` 并完成人工评审。

## 后果

- 缺少完整产品 evidence 时，M04 G02 及其后续 Goal 保持 blocked；存在 ADR 或代码草案不构成准入。
- 若未来 WebGPU 标准加入硬件 RT，必须新增 ADR、feature detection、parity、设备和生命周期证据，不能
  静默替换本后端。
- 第一版 API 保持 experimental；稳定 subpath、baseline 晋升和默认产品集成只能在 M04 集成验收后决定。

详细身份、布局、诊断和 evidence schema 见
[Ray tracing contracts](../ray-tracing/contracts.md)。

## 验证

- `node --test scripts/capability-admission-policy.test.mjs`
- `npm run capability:admission:check`
- 完整 fast gate 在多仓迁移后恢复原验证集合，不能以精简脚本替代。
