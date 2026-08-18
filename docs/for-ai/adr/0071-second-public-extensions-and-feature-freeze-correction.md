# ADR 0071：第二批 Extensions 转正与 Feature Freeze 范围纠偏

- 状态：Accepted
- 日期：2026-08-13
- 影响范围：`engine`、`extensions`、public package release contract、feature freeze、API baseline

## 背景

ADR 0070 在 feature freeze 后完成了首批 extensions 转正，但冻结审核漏掉了一组已经在 freeze 前完成、并被 examples、games 或编辑器持续使用的成熟能力。把这些既有能力继续标记为 experimental 会让 0.1 的发布合同与实际成熟度不一致。用户因此明确要求执行第二批，并更新 feature freeze 结果。

这不是恢复一般功能开发。纠偏只处理审核时遗漏的既有能力、完成其稳定边界收口，并在同一变更中重新冻结发布输入。

## 决策

1. 第二批 stable entrypoints 为：
   - `@haiyue/extensions/animation`
   - `@haiyue/extensions/hya-state-machine`
   - `@haiyue/extensions/spine`
   - `@haiyue/extensions/tilemap`
   - `@haiyue/extensions/canvas-text`
   - `@haiyue/extensions/tween`
   - `@haiyue/extensions/grid`
2. ADR 0070 的三个 stable entrypoints 保持不变；因此 0.1 共承诺十个 extensions 业务 runtime subpath。
3. `@haiyue/extensions` 根入口继续作为最小 authoring base，并保持 experimental；不把可选 runtime 聚合回根入口。
4. Spine 的 worker client、source builder、parser 与 parsed payload 从 stable `/spine` 移到 `@haiyue/extensions/experimental/spine-worker`。stable `/spine` 只保留 component、render system、plugin 与可替换的结构化 `SpineAssetWorker` 接口。
5. glTF worker/parser 继续位于 `@haiyue/extensions/experimental/gltf-worker`。
6. Engine 增加 stable `@haiyue/engine/extension-authoring` 窄 SPI，只提供外部渲染扩展所需的帧命令、设备访问、层级可见性、对齐/显存估算与资源记账钩子。它不得成为新的 engine aggregate，也不暴露完整 diagnostics tracker。
7. 第二批 stable declarations 不得依赖 `@haiyue/engine/experimental`。资产、ECS、组件、renderer 和 core 类型继续从各自已有稳定 subpath 引用。
8. Feature freeze 保持 active，允许的新工作仍只有 P0/P1 release blocker。本次变更在 manifest 中分类为 `refrozen-after-omitted-mature-capabilities`，不构成后续新增能力的先例。
9. release manifest、API baseline、真实 tarball consumer、入口体积预算、声明边界测试、文档与示例调用路径在同一纠偏中重新冻结。

## 后果

- 外部调用方可以使用仓库已经验证的 2D 动画、状态机、Spine、Tilemap、Canvas Text、Tween 和 Grid，而不依赖 experimental package contract。
- worker transport、source generation、parser payload 与 diagnostics mutation 仍可演进。
- 后续任何不在本 ADR 清单内的新能力，仍受 feature freeze 原规则约束。

