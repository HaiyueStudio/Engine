# Repository map

HaiYueStudio 已迁移为 `D:\\HaiyueStudio` 下的多仓库布局。本文件位于 `Engine` 仓库；表中的兄弟仓库
是发布/集成输入，不是 Engine source workspace，Engine 源码不得反向依赖它们。

## Engine 仓库内的运行时

| 目录 | 职责 | 主要验证 |
| --- | --- | --- |
| `engine/` | ECS、场景、渲染、材质、资源、输入和底层运行时 | `npm test -w ./engine` |
| `extensions/` | glTF、Spine、动画和 experimental ray tracing 等可选完整能力，包括组件、加载器、Worker、运行时和适配器 | `npm test -w ./extensions` |
| `animation-spec/` | Web 动效规范、解析器与格式转换 | `npm test -w ./animation-spec` |

## 兄弟产品仓库

| 仓库 | 职责 | 主要验证 |
| --- | --- | --- |
| `../UI/` | 编辑器和工具共用的 Web Components | 在 UI 仓库运行 `npm run typecheck && npm test` |
| `../Editor/` | Scene、Animation、Voxel 三个编辑器及共享平台/app kit | 在 Editor 仓库运行 `npm run typecheck && npm test` |
| `../Games/` | 产品级游戏与组合回归场景 | 在 Games 仓库运行 `npm run typecheck && npm test` |
| `../milestones/` | 私有里程碑、Goal 状态和跨仓集成顺序 | 按该仓库 `AGENTS.md` 验证 |

## 独立编译工具与规范

| 目录 | 职责 | 主要验证 |
| --- | --- | --- |
| `shader-language/` | public build-time Composer 2.0、Typed IR、Graph v1、MaterialSurface/PBR/Fog lowering、Compute IR、构建期 Artifact V2、WGSL backend 与 GLSL ES 300 feasibility；不进入 engine runtime | `npm run shader-language:check` / `npm run verify:shader-language-stage14` |

## 可运行证据

| 目录 | 职责 |
| --- | --- |
| `examples/` | 单项引擎能力的最小可运行示例 |
| `scripts/` | 架构门禁、构建、benchmark 和真实浏览器验证 |
| `config/` | 发布矩阵等机器可读配置 |

## 规划与文档

| 目录 | 职责 |
| --- | --- |
| `docs/for-ai/` | 稳定架构事实、ADR、边界与门禁 |
| `docs/for-ai/runtime-convergence/` | M2.5 冻结的 shader、render scheduling、renderer、async/Worker、compute/GUI 与 optional SceneBatch owner/验证合同 |
| `docs/editor-guide/` | 编辑器用户教程 |
| `docs/engine-guide/` | 代码开发教程与功能指南 |
| `docs/api/` | API 与错误码参考 |
| `../milestones/` | 当前里程碑、Goal 依赖、并行 write scope、共享契约和串行集成顺序 |
| `review/` | 评审结论、阶段基线和数值证据 |
| `todos/` | 尚未进入里程碑的候选事项，不代表当前实现或已批准计划 |

修改时优先更新权威来源：架构决策更新 ADR，用户工作流更新 Guide，公开签名更新源码声明和 API 基线，活动执行计划更新 `milestones/`，阶段结果更新 `review/`，未纳入计划的候选工作更新 `todos/`。
