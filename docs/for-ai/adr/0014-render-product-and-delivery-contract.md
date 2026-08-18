# ADR 0014：RenderProfile、PBR 产品闭环与 manifest 交付契约

- Status: Accepted
- Date: 2026-07-13

## Context

3D 优先路线已有批处理、资产和编辑器能力，但普通用户需要组合多个布尔开关，设备能力会隐式降级；examples/games 又依赖目录扫描与散落 CI 列表。继续增加渲染特性会放大不可解释配置和交付漂移。

## Decision

1. stable API 只暴露 `simple`、`batched`、`gpu-driven`、`diagnostic` 四个声明式 RenderProfile；默认 `batched`。删除旧布尔组合，不保留兼容层。
2. 初始化和 device recovery 都生成不可变 capability report，逐项记录 requested、enabled、fallback、reason。
3. 3D 产品闭环以 glTF metallic-roughness PBR、directional shadow、environment IBL、material variants 和 MaterialShaderContract 为一组原子能力。
4. 每项产品渲染能力同时具备参考场景、真实像素回归、性能预算、fallback、资源释放验证和文档。
5. examples/games 的 manifest 是构建、预览、CI 和能力覆盖的唯一目标来源。共享 Rollup policy 统一 WGSL、worker URL、external、sourcemap、declaration 与 workspace resolution。
6. 发布由机器可读 browser/device matrix 和统一 release gate 驱动。

## Consequences

普通项目配置可解释、设备降级可观测。PBR 成为编辑器默认 3D 材质与 glTF 唯一路径。增加 example/game 时必须先登记 manifest；增加 stable capability 时必须同时扩展覆盖矩阵和发布证据。低层算法实验继续位于 experimental，不污染 stable 入口。
