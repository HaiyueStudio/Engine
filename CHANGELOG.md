# Changelog

## Unreleased

- 0.1 首发正确性矩阵收敛为 Windows 10 22H2+ Chrome/Edge 与真实 GeForce/Radeon RX 独显；取消 Apple/Windows 集显的独立 required handoff，并将 Chrome/macOS 调整为 extended。软件与远程虚拟 adapter 继续禁止。
- 将 `@haiyue/extensions` 纳入公共 npm 包；在首批 `/animation3d`、`/gltf`、`/gltf-animation3d` 后，经 feature-freeze 漏审纠偏将 `/animation`、`/hya-state-machine`、`/spine`、`/tilemap`、`/canvas-text`、`/tween`、`/grid` 转正。glTF/Spine worker transport 与 parser 底层分别保留在 `/experimental/gltf-worker`、`/experimental/spine-worker`。
- 新增 stable `@haiyue/engine/extension-authoring` 窄 SPI，使独立渲染扩展不再依赖 engine experimental 声明；feature freeze 仍保持 active。
- 新增 stable `@haiyue/engine/diagnostics`，只返回深冻结的 frame 与 GPU resource 聚合快照；instrumentation、资源明细和 tracker 写协议继续留在 experimental。
- 冻结 `@haiyue/animation-spec` 的状态机 channel capability registry，以及 stable `/native3d` source-neutral parser/types；HYA core、binary container、2D/3D project schema 与 npm 版本继续独立演进。
- 补齐首发公共包安装/入口/lifecycle/error 文档、manifest 驱动的 Engine/HYA 黄金路径、WebGPU/灯光/NavMesh/HYA 支持边界、故障排查、贡献说明与 0.1.0 release-note candidate；不新增 WebGL2 fallback、完整 Lottie fidelity 或 mixed HYA 2D/3D 承诺。
- PBR 材质新增 `KHR_materials_transmission`/`KHR_materials_volume` 原生导入导出、编辑器持久化与基于不透明场景颜色快照的 WebGPU 折射/体积衰减路径。
- 恢复 editor 真实 gzip 门禁（初始入口 175,000 bytes），并为真实 renderer 与平面反射建立按 adapter 匹配的 P95/样本数预算、revision-bound 多设备证据和 release 聚合失败机制；未登记的 required Windows 设备不再被报告型配置伪装成绿色。
- 按运行时职责拆分 Render3DSystem、glTF loader、ResourcePool、player 与 runtime export；原入口保留编排/兼容导出，新增反向依赖与职责回流门禁。
- 将 `@haiyue/engine` 默认稳定入口从 427 个符号收敛为精确的 30 个黄金路径概念；高级能力保留在领域子入口，全仓 import 与编辑器 runtime project 生成器已原子迁移，API gate 禁止根名单漂移。
- 新增 9 个符号的稳定 `@haiyue/engine/navigation` 入口，提供共享高度场 NavMesh、代理查询、可复用路径结果和动态障碍；该能力不进入默认入口。
- 2D 物理改为可替换 backend SPI：新增 19 个符号的 `@haiyue/engine/physics/backend`，并以 opaque handle 取代 `Physics2DBody.body`、`Physics2DJoint.joint` 和公开 `physicsWorld` 对 Box2D 对象的直接暴露。这是有意的破坏式变更。
- 分离 World 逻辑帧与 FrameData 阶段修订：一次 `World.update()` 只递增一个 `frameId`，系统更新后的 Transform/Camera/Environment/SpatialIndex 通过 `phaseRevision` 统一失效，多个 RenderIntegration 共享无分配 `WorldFrameToken`。
- 建立 RenderViewFamily 多视图执行：一个 Render3DSystem 每帧只提取一次 WorldFrameState，各 view 独立完成相机、剔除、排序、uniform slot 与 LOD 选择；删除 RenderPipeline entry-local target，LOD 不再修改共享 Mesh3D。
- 修复 viewport-scissor 多相机与交互：四个 RenderView 共享一个 Render3DSystem，OrbitControl 通过归一化 `inputRegion` 直接绑定真实渲染 canvas，并让复用的 Camera3DFrameData 按 frameId/phaseRevision 刷新 SceneFrameUniform snapshot。
- 建立 importer-neutral `MaterialDescriptor` 与无状态 glTF Extension Adapter：Clearcoat、variants、纹理/UV 语义由统一 descriptor compiler 接入，支持每次加载的不可变自定义扩展集合。
- 破坏式重置 engine 稳定 API：根入口移除 serialization 聚合，core/assets/ecs/scene/systems 的实现型能力统一迁到 `@haiyue/engine/experimental`，并以逐入口预算和声明泄漏检查冻结新边界；不保留兼容 re-export。
- 修正方向光阴影 caster 正确性：caster 候选集不再依赖主相机可见列表，改由光源视锥二次裁剪；阴影 draw 共享 object table，并覆盖 Basic GPU morph/skinning 变体与 pipeline warmup。
- 固化灯光/阴影规模化的 benchmark-first 决策：Forward+/clustered、GPU light list 与级联阴影必须由真实 game、多灯和多 viewport 证据触发，当前不扩张渲染实现。
- PBR 增加 Clearcoat 双 pipeline 变体、`KHR_materials_clearcoat`、动态 UV/纹理生命周期、编辑器 inspector/runtime export，以及真实 WebGPU on/off 像素门禁。
- 普通场景统一为 `createScene → switchScene → run`；新增场景更新后的 `after-update` 帧 hook，并让 engine destroy 清理 active scene listeners 与 owner。

## 0.1.0 - 2026-07-13

- 建立海月 3D 优先的稳定包边界、生命周期、编辑器工作流、可观测性、资产管线和脚本 runtime。
- 用 `simple` / `batched` / `gpu-driven` / `diagnostic` RenderProfile 替换公开渲染布尔开关，并加入显式设备降级报告。
- 加入原生 glTF metallic-roughness PBR、directional shadow map、environment IBL、material variants 和可扩展材质 shader contract。
- examples/games 改为 manifest 驱动，统一 build policy、能力覆盖矩阵、真实 WebGPU 像素基线和 release gate。
