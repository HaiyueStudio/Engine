# ADR 0054: 2D/UI 与 simple-3D Shader Module Family 生产迁移

- 状态：Accepted
- 日期：2026-07-28
- 关联：ADR 0050、0051、0052、0053

## 背景

阶段 8 已证明 compiler-owned module family 可以替换复杂 builtin postprocess，但 2D/UI 和 simple-3D 有不同的 vertex ABI、多 group 布局、包边界和 bundle 特征。把它们强行套进 postprocess 的 artifact-owned 单 group 会破坏现有 renderer 责任，也会使 components 依赖 engine 私有实现。

## 决策

1. 建立 `2d-ui` 和 `simple-3d` 两个 compiler-owned family；2D/UI 再按 engine/components 包边界输出两个 delivery slice。
2. family JSON 只声明 operation，WGSL、binding、uniform layout、vertex ABI 与 capability reflection 由 Shader Language standard library 决定。
3. 17 个 production WGSL 入口改为 checked-in generated 输出，删除原 engine/components 手写入口。
4. 现有 renderer 继续拥有全部 bind-group layout。engine pass 使用 Artifact V2 runtime 物化 module/pipeline layout；components 直接消费 generated WGSL，并用私有 Artifact V2 browser fixture 验证 reflection。
5. 不增加 engine/components package export，不更新 API baseline，不改变 draw scheduling、render state、binding 或 vertex ABI。
6. engine 阶段 9 artifact entry 的 gzip 合计预算为 12,000 bytes；components 公共 entry 不加载 reflection evidence artifact。
7. Basic skinned 保持现有 morph-then-skin 和 group 3 ABI。deformation 的多 pass 一致性留给阶段 10 整体迁移。

## 结果

- 2D/UI 与 simple-3D 的 production shader 来源进入同一构建期 compiler/reflection 体系。
- engine runtime 不再为这 13 个 pass 直接创建 shader module/pipeline layout；components 不产生反向私有依赖。
- 真实 WebGPU 门禁覆盖 17 个 pass、45 个 renderer-owned layout 和一个 components production pixel。
- compiler standard library 与尚未迁移 legacy feature 在阶段 10 前短期并存；不得把这种过渡复制扩展到新的 production shader。

## 否决方案

- 把所有 renderer 改成 artifact-owned layout：会越过现有 GPU 资源所有权并制造大范围 ABI 改动。
- 让 components 导入 engine source/private subpath：会破坏 workspace/package 边界并形成事实公开 API。
- 每个 shader 机械创建独立 DSL：无法复用 family operation、reflection 和生成门禁。
- 在阶段 9 顺带迁移 PBR/deformation：会把多 pass skin/morph/history 一致性风险混入本轮。
