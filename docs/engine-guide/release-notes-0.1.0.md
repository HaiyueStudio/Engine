# Haiyue 0.1.0 首发候选说明

这是 G05 提供给 RC 集成的 release-note candidate，不代表已经发布或 publish-ready。最终支持矩阵、制品哈希、正式 evidence 和 go/no-go 由 G07 在 frozen clean HEAD 上确认。

## 首发内容

- 三个公共 npm 包：`@haiyue/engine`、`@haiyue/animation-spec` 与 `@haiyue/extensions`；extensions 的稳定入口覆盖 Animation2D/3D、glTF、HYA 状态机、Spine、Tilemap、Canvas Text、Tween 与 Grid，worker/parser 底层协议保留在 `/experimental/*`。
- Engine 的 30 符号根黄金路径，以及按领域拆分的 stable subpath；低层 renderer、GPU-driven 和诊断协议留在 experimental subpath。
- WebGPU-only 2D/3D Scene、PBR/glTF 工作流、资产 owner、输入、物理、NavMesh、后处理和设备恢复。
- HYA 1.0 JSON/binary codec、Lottie 转换、状态机 channel capability，以及 stable `/native3d` 格式解析入口。
- Scene Editor、AnimationEditor、Voxel PWA、Examples 和 Games 静态交付；Voxel Electron 是 unsigned preview。

## 动画与格式兼容

HYA core/container、AnimationEditor 2D/3D project schema 和 npm package 分别版本化。0.1.0 不把 npm 版本解释为数据格式版本：

- HYA core：`haiyue-animation@1.0`；binary reader 支持 v1/v2，writer 生成 v2。
- 2D project：`haiyue-animation-editor-project@1`，schema version 1。
- 3D project：`haiyue-animation-editor-project-3d@1`，schema version 1。
- 原生 3D HYA：required `org.haiyue.animation-3d@1` 扩展；不会扩大或重解释 HYA 2D core。

本候选新增并冻结两个 intentional Animation Spec surface：状态机 channel capability registry，以及 `@haiyue/animation-spec/native3d` 的 source-neutral parser/types。2D/3D runtime facade 由公开的 `@haiyue/extensions` focused stable subpath 提供；worker transport 与 parser payload 等底层协议仍保留为 experimental。

## 迁移与稳定性

- Engine 根入口已经收敛为精确黄金路径；原先从根导入的高级符号必须改用对应 stable subpath，private/experimental 符号不会提供兼容 re-export。
- TypeScript consumer 承诺为 5.2+、ESNext、`moduleResolution: Bundler`、`skipLibCheck: false`。
- 0.1.x patch 只接受兼容修复。Stable API 增长或破坏、experimental 破坏与数据格式迁移都需要对应版本策略、API diff、文档和 release note。

## 刻意不承诺

没有 WebGL2 fallback、完整 Lottie fidelity、HYA 原生 mixed 2D/3D、Forward+/Clustered、CSM 或固定性能等级。具体容量和诊断行为见[已知限制](./known-limitations.md)。完整变更列表见 [`CHANGELOG.md`](../../CHANGELOG.md)，安装与黄金路径见[新用户 walkthrough](./consumer-walkthrough.md)。
