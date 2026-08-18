# ADR 0062：Material Graph 编译器只进入编辑器 Worker 能力

- 状态：Accepted
- 日期：2026-07-30

## 背景

ADR 0050 确立 Typed Shader IR 和 Graph v1，ADR 0051 禁止 private compiler 进入 engine/player runtime；当时可视化 Graph 编辑器仍明确延期。现在内容生产需要让美术在编辑器中组合 PBR 材质，但直接暴露 Typed IR、把 compiler 静态带进 editor shell，或在主线程同步编译都会破坏既有边界。

## 决策

1. 编辑器持久化 `haiyue-shader-graph` v1 高层资产，只展示受信任的节点目录、连接和 PBR surface slots，不公开 Typed IR、builder、binding number 或 lowering callback。
2. editor domain 只依赖自己的 `MaterialGraphCompilerPort`。唯一允许导入 `@haiyue/shader-language/material-graph` 的文件是独立 module Worker entry；editor shell、player、export worker 和 engine runtime 均不得导入 compiler。
3. preview compile 必须异步；调用方使用 generation/latest-wins，过期结果不得覆盖当前 graph。Abort、Worker error 和能力不可用必须显式报告，不允许静默回退到主线程同步编译。
4. 编译结果是带 canonical hash、variant key、WGSL、reflection 和 cost 的部署 artifact。当前 renderer material binding adapter 尚未交付时，artifact 明确标记 `renderer-adapter-required`，编辑器不得伪装为实时材质预览已完成。
5. Graph v1 是首个可保存的用户格式。未知 format/version、无效 node/resource/output 必须在替换当前资产前失败；编辑器保留上一份有效快照。未来破坏式变化提升 graph version，并提供逐版本纯迁移与备份路径。
6. Material Graph 是独立懒加载 bundle capability，Worker 和面板都进入 bundle graph、体积预算与门禁；不得把 compiler 文件复制到未统计目录规避总包体。

## 后果

- production engine 继续只消费预编译 shader artifact，不携带 compiler。
- editor workspace 新增对 private shader-language workspace 的 authoring-only 依赖，因此 workspace boundary 显式登记该方向，同时 editor boundary 将唯一 import 锁定到 Worker adapter。
- 第一版完成 graph 创建、节点/连接编辑、验证编译、诊断和场景持久化；真正绑定 PBR renderer 的 live preview 仍需后续 adapter，不能通过暴露 IR 绕过。

