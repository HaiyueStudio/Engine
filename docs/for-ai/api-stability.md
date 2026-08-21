# API stability

海月不承担旧项目兼容负担，但仍用稳定性分层控制长期演进成本。稳定子入口边界由 [ADR 0023](./adr/0023-stable-api-boundary-reset.md) 冻结，默认根入口由 [ADR 0035](./adr/0035-root-golden-path-entrypoint.md) 进一步收敛为精确的 30 符号黄金路径。

- `@haiyue/engine` 及所有不以 `experimental` 开头的已声明 subpath 是 stable。破坏式调整必须全仓原子迁移、更新 API 基线、ADR、示例和 changelog。
- `@haiyue/engine/experimental` 是兼容聚合入口；新高级调用方应使用 `/experimental/assets`、`/experimental/diagnostics`、`/experimental/gpu-driven` 或 `/experimental/renderer`。这些入口都可在 minor 迭代重构，不进入普通用户主路径。
- `@haiyue/extensions` 的十个业务 runtime subpath 是 stable；根入口与 `/experimental/*` worker/parser 协议仍为 experimental。
- 包内未由 `package.json#exports` 暴露的文件是 private，禁止跨 workspace 导入。
- 编辑器导出格式和脚本 capability 都带独立版本；数据迁移不等于保留旧 TypeScript API。

## 0.1 首发公共面

公共 npm 包是 `@haiyue/engine`、`@haiyue/animation-spec`、`@haiyue/extensions`、`@haiyue/shader-language` 与 `@haiyue/ui`。`@haiyue/animation-spec` 的来源无关格式与离线 adapter 为 stable；extensions 按 ADR 0070/0071/0085 承诺已准入的 focused runtime，ray tracing 保持 experimental。UI Web Components 与 Shader Language build-time compiler 使用独立 focused entrypoint；三个编辑器 package 仍为 private workspace。所有入口的能力归属和增长储备由 [`config/public-api-capability-budgets.json`](../../config/public-api-capability-budgets.json) 管理。

0.1.x patch 只接受兼容修复。新增 stable API 需要评审后的 minor；stable 破坏必须显式进入新的 minor、提供迁移说明并完成全仓迁移。Engine experimental 入口可在 minor 破坏，但必须保留 API diff 和 release note。应用、npm 包、HYA core、HYA binary container、AnimationEditor 2D/3D project schema 与 Shader artifact 各自版本化，不能用 npm 版本替代数据格式版本。

按 [ADR 0074](./adr/0074-pre-release-runtime-convergence-sequencing.md)，M2.5 在 0.1 最终 RC 前执行内部 runtime 收敛。该阶段默认不得改变本页 stable declaration、错误 code 或已冻结数据格式；private/experimental seam 的调整也必须由最终 API diff 和 packed consumer 证明没有泄漏到首发公共面。

首发 artifact、入口、版本、支持级别、验证命令、渠道和 rollback unit 的唯一冻结输入是 [`review/api/release-manifest.json`](../../review/api/release-manifest.json)。浏览器和设备集合只由 [`config/release-matrix.json`](../../config/release-matrix.json) 定义；manifest 只能引用它，不能复制一份会漂移的浏览器列表。原始边界记录在 [ADR 0068](./adr/0068-first-public-release-surface.md)，extensions 与 diagnostics 的重冻由 [ADR 0070](./adr/0070-first-public-extensions-and-readonly-diagnostics.md) 修订。

## 稳定入口职责

| 入口 | 稳定职责 | 不属于该稳定入口 |
| --- | --- | --- |
| `@haiyue/engine` | 普通游戏黄金路径及稳定领域 API 聚合 | serialization、worker、cache、GPU 资源与帧诊断 |
| `/core` | Engine、生命周期、事件、插件能力协议、声明式 RenderProfile、RenderView | plugin host 实现、设备要求 helper、能力协商实现、资源追踪与帧诊断；也不通过 Engine 属性泄漏 |
| `/assets` | AssetManager、AssetJob/owner、高层 KTX2 texture loader | cache/scheduler/parser、worker client/source、KTX2 inspect/prepare/upload |
| `/diagnostics` | 深冻结的 frame 与 GPU resource 聚合快照 | recorder/tracker 写方法、资源句柄、owner/label/stack |
| `/extension-authoring` | 独立扩展所需的 command context、device guard、资源估算/记账与共享资源能力 | 完整 renderer cache、diagnostics tracker 与 instrumentation |
| `/ecs` | Component、Entity、System、World、Query 与普通层级状态查询 | ID allocator、层级帧缓存、SpatialIndexService |
| `/material` | 稳定材质、importer-neutral MaterialDescriptor 与材质创建协议 | importer schema、glTF adapter 实现、renderer cache 与 GPU 资源 |
| `/scene` | Scene、公开配置与 pipeline warmup | preset 表、system plan、配置 normalization、RenderPipeline/Integration 与 registry/host 实现 |
| `/systems` | 可直接装配的系统及其公开配置 | Render3D 内部 frame plan 与诊断快照 |
| `/serialization` | 显式选择使用的序列化协议 | 默认根入口 re-export |
| `/save` | 游戏无关的存档信封、校验、存储后端、checkpoint 与文件导入导出 | 游戏规则、账号云同步、浏览器无权管理的外部磁盘文件 |
| `/experimental` | 旧调用方兼容聚合；冻结符号预算，不再作为新增能力默认入口 | experimental |
| `/experimental/assets` | cache、scheduler、worker-first parser 与 KTX2 低层上传 | experimental |
| `/experimental/diagnostics` | frame/GPU timing 与 GPU resource ownership 诊断 | experimental |
| `/experimental/gpu-driven` | indirect command、GPU cull/sort、mega-batch/readback | experimental |
| `/experimental/renderer` | pipeline、warmup、renderer cache/arena 与 registration internals | experimental |
| `@haiyue/extensions/animation3d` | 来源无关 clip/pose/mixer/layer/mask/event/state machine 与 HYA adapter | importer/renderer 内部实现 |
| `@haiyue/extensions/gltf` | glTF load/component/system/plugin、material adapter、兼容报告 | worker source/client、parsed asset 与 geometry preparation |
| `@haiyue/extensions/gltf-animation3d` | glTF clip 到 Animation3D runtime 的 adapter | glTF parsing 与 engine instrumentation |
| `@haiyue/extensions/animation` | Animation2D component/system、资产加载与渲染 | worker transport 与 renderer internals |
| `@haiyue/extensions/hya-state-machine` | HYA 2D 状态机 component/system 与 channel contract | editor authoring internals |
| `@haiyue/extensions/spine` | Spine component/system/plugin 与结构化 worker seam | worker client/source builder、parser 与 parsed payload |
| `@haiyue/extensions/tilemap`、`/canvas-text`、`/tween`、`/grid` | 聚焦的 2D runtime components/systems/plugins | GPU renderer implementation |

Stable 自定义材质 API 只包含 `MaterialRendererRegistration`、`MaterialRenderContext` 等能力协议。GPU-driven table/readback、command buffer、renderer cache、内部 frame plan 和 compute pass 的具体实现只允许由 `@haiyue/engine/experimental` 暴露。

`MaterialDescriptor` 是 importer 到 engine 的稳定声明边界；glTF schema、extension adapter 和 descriptor compiler 属于 `@haiyue/extensions/gltf`。descriptor 不拥有 texture/GPU 资源，具体材质仍由 engine factory 创建并遵守现有生命周期。

## 门禁

`api-surface` 同时检查导出清单、公开声明中的类型泄漏和每个 stable entrypoint 的符号预算。根入口不是“最多 30 个”的可替换额度，而是必须与 ADR 0035 名单完全一致；新增普通 stable API 应优先进入领域子入口。执行 `api:update` 不能绕过边界检查。新增 stable API 必须先修改 ADR/预算，并同时提供声明、最小 example、测试和文档。

发布前运行 `npm run api:check` 和 `npm run release:check`。删除旧 API 时不得留下 deprecated alias、旧入口 re-export 或双字段读取。
