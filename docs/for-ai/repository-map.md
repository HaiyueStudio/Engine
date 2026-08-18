# Repository map

## 产品与运行时

| 目录 | 职责 | 主要验证 |
| --- | --- | --- |
| `engine/` | ECS、场景、渲染、材质、资源、输入和底层运行时 | `npm test -w ./engine` |
| `extensions/` | glTF、Spine、动画等可选完整能力，包括组件、加载器、Worker、运行时和适配器 | `npm test -w ./extensions` |
| `animation-spec/` | Web 动效规范、解析器与格式转换 | `npm test -w ./animation-spec` |
| `ui/` | 编辑器和工具共用的 Web Components | `npm run typecheck -w ./ui` |
| `editor/` | 场景编辑器、工作流、导出与运行预览 | `npm test -w ./editor` |
| `voxelEditor/` | 独立体素编辑器产品 | `npm test -w ./voxelEditor` |

## 独立编译工具与规范

| 目录 | 职责 | 主要验证 |
| --- | --- | --- |
| `shader-language/` | private Composer 2.0、Typed IR、Graph v1、MaterialSurface/PBR/Fog lowering、Compute IR、构建期 Artifact V2、WGSL backend 与 GLSL ES 300 feasibility；不依赖或导出到 engine | `npm run shader-language:check` / `npm run verify:shader-language-stage14` |

## 可运行证据

| 目录 | 职责 |
| --- | --- |
| `examples/` | 单项引擎能力的最小可运行示例 |
| `games/` | 组合多项能力的产品级游戏与回归场景 |
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
| `milestones/` | 当前里程碑、Goal 依赖、并行 write scope、共享契约和串行集成顺序 |
| `review/` | 评审结论、阶段基线和数值证据 |
| `todos/` | 尚未进入里程碑的候选事项，不代表当前实现或已批准计划 |

修改时优先更新权威来源：架构决策更新 ADR，用户工作流更新 Guide，公开签名更新源码声明和 API 基线，活动执行计划更新 `milestones/`，阶段结果更新 `review/`，未纳入计划的候选工作更新 `todos/`。
