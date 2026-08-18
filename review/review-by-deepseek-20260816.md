# HaiYue Engine 架构评审（DeepSeek 独立评审）

- 评审日期：2026-08-16
- 评审对象：WebGPU 渲染引擎 monorepo，重点 `engine/`，并覆盖 `shader-language/`、`extensions/`、`animation-spec/` 以及物理/导航/计算/GUI/资产子系统。
- 评审方式：对核心源码（`engine/src` 的 ECS、生命周期、RenderPipeline/RenderIntegration/RenderCommandContext、RenderProfile、FrameData、RenderView、材质、ComputeKernel、Geometry3D、physics facade）的第一手阅读，叠加三份并行子代理深挖（3D 渲染管线、shader-language 编译器、extensions/物理/计算/GUI/资产）。
- 性质声明：本文件是**独立架构评审结论**，不是正式发布证据，不替代任何 CPU/GPU/像素/截图/性能/发布基线，也不构成对现有 ADR、门禁或发布状态的修改。

---

## 1. 总体判断

这是一个**成熟度异常高、工程纪律非常强**的 WebGPU-first 2D/3D 引擎。它不像典型的"渲染 demo 仓库"，而是围绕**生命周期所有权、API 稳定性分层、可观测性、真实设备证据门禁**建立起来的严肃产品工程：73 份 ADR、机器可读的边界检查脚本、冻结的 API 符号预算、真实浏览器/像素/性能回归。

同时它也是一个**"以门禁兜底复杂度"**的仓库：核心渲染热路径（`Render3DSystem` 1242 行 + 约 40 个 `Render3D*` 协作文件）的复杂度已高到需要用 `modules:check`、`responsibilities:check`（ADR 0037）这类负向脚本去约束，这本身就是一种信号。

三份深挖后，最核心的三条架构债被行级证据坐实：

1. **生产 shader 面整体绕过了 Typed IR**（见 §5.1）——所谓"单一语义表示"目前只对 authoring 前端成立。
2. **3D 渲染的最大债是"渲染器近重复"**，而非单纯文件多（见 §5.2）。
3. **跨子系统的底层一致性是普遍短板**（worker 协议、abort 错误、序列化版本、生命周期基座各自长成，见 §5.4）。

---

## 2. 架构方式

### 2.1 Monorepo 分层 + 依赖方向强制

- `engine`（零 workspace 依赖的运行时基座）→ `extensions`（可选完整能力，只依赖 `engine`/`animation-spec`）→ 产品层（`editor`/`games`/`examples`/`voxelEditor`）。
- `shader-language` 是**私有构建期编译器 workspace**，不进 engine runtime bundle，也不导出给 engine。
- 依赖方向由 `config/architecture-boundaries.json` + `scripts/check-workspace-boundaries.mjs` 强制。

### 2.2 ECS：OOP 风格 entity-component（非数据导向 SoA）

`World`/`Entity`/`Component`/`System`/`Query`（`engine/src/ecs/`）：

- 组件按**构造器 + `UniqueSymbol`** 建索引，查询用 `all/any/none` 描述符，取最小候选集做交集（`World.iterQueryCandidates`）。
- 有**非破坏式组件变更日志**（`WorldComponentChangeJournal`，环形缓冲 + revision 游标）。
- 有 `structureVersion`/`hierarchyVersion` 脏标记，`FrameData` 据此做增量相机/变换缓存。
- 这是"每实体一个 JS 对象 + Map/Set 索引"的模型，**不是** archetype/SoA 列式存储。

### 2.3 渲染：record-based 管线 + 两套调度抽象并存

- 执行链：`World.update()` → `RenderIntegration.update()`（`WorldRuntimeIntegration`）→ `RenderPipeline.execute()`（有序 `record()` 系统列表 + pass 共享/load-store 协商 + compute 条目 + 诊断快照）→ `Render3DSystem.record()`（orchestrator）。
- `RenderCommandContext` 负责 encoder/pass 生命周期、`afterSubmit` 回调（readback 顺序协调）、通过 **Proxy 装饰 encoder** 注入 GPU timestamp。
- 另存在 `core/RenderGraph.ts`：小型确定性 DAG（单写校验、死代码消除、拓扑排序、transient 资源生命周期/别名），注释说"used by the frame planner"。
- `RenderView`/`RenderViewFamily`：不可变快照缓存 + 多视图（主视图/阴影/镜面）；`FrameData` 用相位令牌（`WorldFrameToken`）保证同帧多视图共享一次 World 提取。

> 注意：`RenderPipeline`（有序列表）与 `RenderGraph`（DAG）是**两套并存的调度模型**，这是架构演进中的一个裂缝。

### 2.4 材质：importer 中立边界 + 完整 glTF PBR

- `MaterialDescriptor` 是 importer 到 engine 的稳定声明边界，`createMaterialFromDescriptor` 负责校验与具体材质构造。
- `PbrMaterial`（960 行）覆盖 glTF PBR 全扩展：clearcoat、ior、specular、sheen、transmission、volume、attenuation、每槽 sampler 覆盖、KHR_texture_transform、variants、morph/skinning。

### 2.5 能力协商：声明式 `RenderProfile`

`simple/batched/gpu-driven/diagnostic` 四档，`createRenderCapabilities` 产出逐能力决策（requested/enabled/fallback/reason），缺 `indirect-first-instance` 时自动降级到 `batched`，全程结构化、可观测。

### 2.6 生命周期与设备恢复

`Engine.ts`：状态机 `created→initializing→ready→lost→recovering→failed→destroyed`；`_handleDeviceLost` 做 8 阶段恢复（suspend → 释放 GPU 资源 → 重建 device → 恢复资产 → 恢复场景），有 `RecoverableGpuResource` SPI 与 AbortSignal 全程贯穿。

### 2.7 可观测性

`FrameDiagnostics` + `GPUResourceTracker`（`debug`/`captureStacks`）+ `diagnostics` 只读门面（ADR 0070）；渲染侧有 GPU pass 级 timing（`GpuPassProfiler`）。

### 2.8 插件体系

`EnginePluginHost`（scope: `engine`）+ `ScenePlugins`（scope: `scene`），带 rollback tracker、依赖启用状态、`registerComponent`/`registerAssetLoader` 上下文。

---

## 3. 能力清单（从代码/导出/门禁反推）

| 域 | 能力 |
|---|---|
| 渲染 | metallic-roughness PBR、Toon（4 层）、BlinnPhong、Instanced、2D、GUI、粒子(2D/3D)、Line、BitmapText、Sky、Volume(raymarch)、PlanarMirror、实体级多平面 clipping |
| 阴影/光 | 固定容量多方向光 shadow depth array（ADR 0049）、RadialShadow、环境 IBL、经纬图→cubemap 转换 |
| 后处理 | TAA（ADR 0029）、view-local motion blur（ADR 0034）、AO（GTAO/SAO/SSAO，ADR 0060）、距离/高度 Fog |
| GPU-driven | indirect draw、GPU culling/sort、mega-batch、transparent mega-batch、readback（`experimental/gpu-driven`） |
| 几何 | 非索引三角分离、线性细分、约束 QEM 简化（ADR 0045/47/48）、BVH mesh LOD（ADR 0022） |
| 资产 | `AssetManager`/`AssetJob`（8 态生命周期）、KTX2/Basis、worker client、Draco |
| 动画 | `animation-spec`（HYA/Lottie/native3d）+ `extensions` 的 2D/3D clip/pose/mixer/state-machine/blend-tree |
| 物理 | Box2D(2D) + Rapier(3D)，统一 backend SPI（ADR 0038/40），joints/buoyancy/gravity/2D→3D 同步 |
| 导航 | navmesh（多层、表面孔洞）+ 第一人称控制（ADR 0036/64） |
| 计算 | `ComputeKernel` 薄封装 + 生产 compute shader family（ADR 0058） |
| ECS | 层级、查询、变更日志、结构版本、序列化、跨 World transfer |
| 工具 | Scene Editor / AnimationEditor / VoxelEditor / Material Graph worker（ADR 0062） |

---

## 4. 优点（有依据）

1. **生命周期与资源所有权是真正的设计主线**。设备丢失恢复覆盖 engine→asset→scene→plugin 全链路，`destroy/dispose/release/abort` 幂等，`afterSubmit` 协调 readback 顺序。每个 GPU owner 实现 `suspendForDeviceLoss()`/`recoverGpuResource()` 并注册进 engine。
2. **API 稳定性分层清晰**：根入口精确冻结 30 个符号（ADR 0035），domain subpath 稳定、experimental 子路径可 minor 破坏、private 模块禁止跨 workspace 导入，由 `api-surface` 脚本同时检查导出清单 + 类型泄漏 + 符号预算。
3. **声明式能力协商**（`RenderProfile`）把 GPU feature 探测、降级、理由全部结构化。
4. **帧架构严谨**：`FrameData` 的相位令牌、相机缓存池、不可变 `RenderViewSnapshot`，为多视图渲染避免重复对象上传提供干净基础。
5. **材质 importer 中立**（`MaterialDescriptor`），让 glTF/Spine 等 importer 不依赖 renderer 内部类。
6. **构建期 shader 编译 + 运行时 adapter**：编译器不进 runtime，生成产物带 hash/reflection，`artifact`/`renderer` 两种 layout 所有权清晰，运行时 adapter 从不重解析 WGSL。
7. **上传去重是真的**：`RendererObjectTable.flushUploads`（脏槽 + gap-merge 成本模型）、`SceneFrameGpuArena` revision 门控、GPU-driven 的 scene-global 表被主/阴影/镜面多视图共享、按代 sweep。
8. **热路径零分配**：render item / sort key / mega-batch run / frame plan 全部池化复用。
9. **正确性优先的透明合批**：`canBatchSortedTransparent` 要求 `transparentDepthSort===false && 无 depth prepass`，只有加法混合材质才合批。
10. **缓冲生命周期正确**：替换的 buffer 走 `afterSubmit`/`onSubmittedWorkDone` 再退役，避免 use-after-destroy。
11. **测试与门禁密度极高**：engine 83 个 test 文件、真实浏览器像素/性能/截图回归、`check:fast`/`check:slow` 阶梯、`release:artifact:check` 打包消费者验证。
12. **结构化错误**（`EngineError` 带 `code/path/hint/docsPath/context`）贯穿边界，不静默降级。

---

## 5. 缺点与风险

### 5.1 shader-language：理想 vs 现实的重大落差（最核心）

文档宣称"Typed IR 是唯一语义表示"，但实际上**生产 shader 面（Stage 8–13）整体绕过了 Typed IR**：

- 生产 family（deformation / material-lighting / postprocess / render-family / specialized / compute）是**手写 WGSL stdlib 模块**（字符串 import）拼接，配**手维护的反射表**（`bindGroups`/`uniformBlocks`/`vertexBuffers`/`varyings`，在 `material-lighting/definitions.ts`、`deformation/production-definitions.ts` 等）。
- 反射元数据是 WGSL 的一份"平行手工副本"——这正是 Typed IR 本要消除的双维护，只是被 `architecture.md` 措辞为"compiler-owned 标准库登记表"。这是一个 Level-2 escape hatch 被用到了**整个生产 shader 面**的规模。

直接后果：

1. **`string.replace()` 绑定重映射违反自家禁令**：`material-lighting/definitions.ts:40-43` 用 `.replace('@group(3) @binding(0)', '@group(3) @binding(8)')` 生成 `pbrSkinning`，而 `escape-hatches.md` 明文禁止"在生成源码上做正则/字符串 replace 迁移 binding"。虽在 build 期对 source 模块做，但模式同样脆弱。
2. **variant 预算已到天花板**：生产基线 **56/58 个 variant**，增量只允许 +2 variant/+22.5KB（`shader-cost-budgets.json`）。PBR 的 clearcoat × transmission 四种组合已是静态 pass。
3. **双 artifact 版本在飞**：motion blur 仍是 V1，其余是 V2；运行时 adapter 同时维护两条路径。compiler 的 `adapter/precompiled-v2.ts` 与 engine 的 `PrecompiledShaderRuntime.ts` **各自独立声明整套 V2 类型面**，只靠 `.generated.ts` 的 `satisfies` 连接。
4. **两个后端成本不对称**：WGSL（生产）+ GLSL ES300（可行性验证）两套 emitter，但 GLSL 只覆盖可移植子集，cross-stage varying 链接、MRT、生产 family 降级均未实现——维护成本已付，覆盖率不足。
5. **两个 IR**：compute 有独立的 `ComputeEffectIr/ComputeDispatchIr`，与 `ShaderIrProgram` 分离。
6. **作者侧 IR 节点预算极小**（showcase 64/60 节点，29 种操作，portable 核心无控制流），复杂材质图会很快触顶。

> 强项仍然成立：IR 语义/坐标/色彩空间不变式校验、canonical hash 抗优化、精确拒绝而非静默降级、确定性内容寻址缓存 + 硬成本预算、编译器完全不进 runtime。

### 5.2 3D 渲染：纪律好、但重复惊人

1. **渲染器近重复是最大架构气味**：`Mesh3DRenderer`/`PbrRenderer`/`BlinnPhongRenderer`/`ToonRenderer`/`DepthRenderer`/`NormalRenderer`/`VolumeRenderer`/`InstancedMesh3DRenderer` 各自重写两套 object table、geometry cache、`writeObjectTableEntry`/`_writeObject`（matrix+morph+skin+clipping-key 去重）、`prepareObjects`/`flushUploads`/`endView`、pipeline keying。抽一个"参数化 mesh-renderer 核心"能省数千行近似重复。（例：`Mesh3DRenderer._writeObjectTableEntry:725-778` vs `PbrRenderer._writeObject:536-590`。）
2. **测试接缝污染 + 死/占位代码**：`Render3DSystem.ts` 大量 `@internal ... retained for tests` 访问器；`Render3DFrameTelemetry.bind()` 用 `Object.defineProperty` 重定义公开字段为内部状态镜像，遮蔽数据流。占位/死逻辑：`RenderPipeline.hasSameRenderTarget()` **恒返回 true**（`:585-587`），导致 `shared-pass-attachment-conflict` 诊断永远检测不到真实 target 冲突；`Render3DTransparentOrchestrator.destroy()` 空 no-op；两条 depth-prepass 分支不可达。
3. **深度量化不一致（真实正确性风险）**：`TransparentMegaBatch` 量化 `viewDepth*1024`，GPU-driven 的 `makeRender3DBatchSortKey` 量化 `viewDepth*16`，CPU opaque 又用另一套 float-bit 技巧。三条排序路径 key 精度不一致，共面透明物体可能被不同路径排成不同顺序。
4. **异步贴图 use-after-destroy 风险**：`Mesh3DRenderer._loadTextureAsync` 只防 stale `sourceTexture`，不防 renderer 在 await 期间被 `destroy()`，迟到的 `AssetManager.loadTexture` 仍可能写回已销毁设备——违反引擎自己的"迟到异步不得写回"规则。
5. **每视图重复计算**：`record()` 先算一遍 `postProcessPasses`/jitter/`cameraFrame` 只为 arena 扩容，`_recordView()` 再算一遍。
6. **共享可变 scratch 对象**（`_materialRenderContext` 等跨视图单例复用）省分配但非重入、易漏重置。
7. **透明路径收益有限**：`TransparentMegaBatch.compareEntries` 按 `order→depth→renderer→material→entity` 排序，depth 是第二键（正确），但 renderer/material 连续性只在等 depth 桶内——唯一合批的是 additive BasicMaterial，PBR/Toon/BlinnPhong 透明仍逐对象一 draw。

### 5.3 未完成/半成品（3D 渲染）

- motion vector 仅 opaque（透明/alpha-clip/skinned 未实现，`Render3DPostScenePasses.renderAuxiliaryBuffers` 注释明确"从 opaque 起步"）。
- PointLight **无阴影**（只有 DirectionalLight 进 `shadowLights`，阴影数组硬上限 3）。
- GPU cull readback **仅遥测**，不回流渲染（未完成的遮挡/反馈闭环）。
- 透明实例合批仅 additive BasicMaterial。
- PBR transmission 只采一层 opaque 场景色（无递归折射/反射）。
- `canShareRenderPass` 的 target 冲突检测未完成（依赖 `hasSameRenderTarget` 恒 true）。

### 5.4 compute / GUI / assets 的一致性与生命周期卫生

**Compute（`engine/src/compute`）**
- 缺 storage→indirect-draw barrier（顺序是未文档化的调用方责任）。
- `COMPUTE_SHADER_STAGE = 4` 魔法数（`ComputePassBase.ts:12`）。
- `TextureConvolutionProcessor.destroy()` 只销毁 `paramsBuffer`，**泄漏 pipeline + bind group layout**，且仅支持 `rgba8unorm`。

**GUI（`engine/src/gui`）**
- `GuiElement` 的 `protected x/y/width/height` 无类型标注（隐式 any，`GuiElement.ts:27-30`）。
- `GuiImageRenderer`/`GuiTextRenderer` 重建 sampler 且从不销毁（只销毁 texture）。
- 序列化把控件值塌缩成 `string|number|boolean|null`，无 schema 版本化（与 ADR 0005 不一致）。
- 15-float（shape）/12-float（text/image）顶点布局在 batch packer 与 pipeline attribute 描述符间重复，`GuiShapeRenderer` 有魔法 `arrayStride: 60`。

**Assets（`engine/src/assets`）**
- `AssetManager._createTexture` 直接写 `record.jobState = 'uploading'`，绕过 `setPhase`/进度事件（`:667`）。
- `AssetUploadScheduler.drainFrame` 里 `if (budget === 0) break;` 不可达（`:136`）。
- `AssetParser.parseAssetWorkerFirst` 已导出但无人调用（KTX2 又内联重实现 worker-first/fallback）。
- `createAbortError` 在五个文件里各自重写；`normalizePriority`/`nowMilliseconds` 重复。
- `AssetWorkerClient` 没有 `error`/`messageerror`/故障退役路径（对比 `Ktx2TextureWorkerClient.failWorker`）——worker 协议三处实现漂移的实锤。
- KTX2 内联 worker `import()` 的是 engine 模块自身（潜在循环/体积隐患）。
- `assets/` 缺 `index.ts` barrel（`compute/`、`gui/` 都有）。

### 5.5 平台级风险

1. **ECS 非数据导向**：`World`/`Entity` 大量 Map/Set/逐实体对象遍历，10k+ 实体 CPU 热路径缓存不友好。`todos/WASM_PERFORMANCE_PLAN.md` 实测 `50000 实体 object cull 0.097ms`，印证要靠 WASM 数值内核补。
2. **渲染侧单线程**：帧循环、culling、排序、命令录制全在 JS 主线程（asset/gltf 有 worker，渲染没有）。
3. **正式发布证据处于 no-go 状态**（`milestones/m02-first-public-release/g07-no-go-report.md`）：Windows 设备未 enroll、HYA 回放两次失败、CPU 基线方差 inconclusive。
4. **文档编码问题**：`README.md` 显示为 GBK/UTF-8 乱码。
5. **测试形态偏 Node mock**：多数测试靠 mock `GPUDevice`，真实 WebGPU 验证靠 `verify:*` 在特定设备跑，mock 与真实设备语义差异需持续对冲。

---

## 6. 需要补全的能力

1. **WASM 数值内核**（已有完整方案 `todos/WASM_PERFORMANCE_PLAN.md`，Phase 0 基准已做，结论是"适合批量 culling/transform/ray batch/instance matrix，不适合搬 ECS"）——未落地。
2. **文本 / MSDF / Markdown 渲染**（`todos/MARKDOWN_MSDF_RENDERING_PLAN.md`）：缺动态 SDF/MSDF 生成、glyph instance 渲染、排版/shaping、Markdown parser。
3. **完整 text shaping / 国际化**：ligature、RTL、combining mark、emoji、fallback font、CJK 断行、HarfBuzz。
4. **渲染/模拟侧 worker 或多线程**：目前 asset 有 worker，渲染没有。
5. **数据导向 ECS / SoA 存储**：目标 10k+ 实体时，在不推翻现有对象模型的前提下叠加列式存储热路径。
6. **正式发布证据补齐**：Windows Chrome/Edge 设备、Windows integrated/discrete GPU 六件套、HYA 回放、CPU 稳定性。
7. **渲染调度收敛**：`RenderPipeline` 与 `RenderGraph` 二选一或明确分层。
8. **流式/异步资产与 GPU 压缩**：有 KTX2/Basis + Draco，缺几何 LOD 流式加载与内存分级。
9. **音频系统**：只有 `AnimationAudioClip`，缺空间音频/混音/衰减。
10. **shader-language GLSL 后端的去留决策**：投入产出需一次明确裁决。
11. **透明渲染能力**：PBR/Toon/BlinnPhong 透明的实例合批、transmission 多层折射、motion vector 透明/蒙皮覆盖。

---

## 7. 架构优化建议（按优先级）

1. **治理生产 shader 双轨（最高优先级）**：把 Stage 8–13 生产 family 逐步迁回 Typed IR，或至少把反射表从"手维护平行副本"变成"从单一 source 自动生成 + 校验"；废除 `.replace()` 绑定重映射；收敛 artifact 版本（V1 motion blur 迁到 V2）；消除 compiler 与 engine 之间的 V2 类型重复。
2. **收敛渲染调度**：要么把 `RenderPipeline` 的有序列表改造成由 `RenderGraph` 编译出的执行计划（拿到自动 pass 合并、transient 资源别名、资源生命周期），要么明确 `RenderGraph` 只服务 frame planner、与 `RenderPipeline` 分层。目前两者关系暧昧。
3. **渲染器去重**：抽一个"参数化 mesh-renderer 核心"（object table + geometry/entity/object-slot/material cache + writeObject + pipeline keying 由 stride/绑定组/shader family 参数化），消除 `Mesh3DRenderer`/`PbrRenderer`/`BlinnPhong`/`Toon`/`Depth`/`Normal`/`Volume`/`Instanced` 的数千行近似重复。
4. **修复两条真实正确性风险**：统一 CPU/GPU 透明排序的深度量化精度；给异步贴图加载补 renderer-destroyed 保护（abort 或 destroy 后不回写）。
5. **清理占位/死代码**：实现或删除 `hasSameRenderTarget`（让 shared-pass target 冲突检测生效）、空 `destroy()`、不可达 depth-prepass 分支、telemetry-only 的 cull readback 要么闭环要么标注。
6. **ECS 叠加 SoA/archetype 列存储作为可选热路径**：不动 `Entity/Component` 公共语义，新增 `World` 内连续 `Float32Array` 存储 + 批量系统（配合 WASM 方案里的 `SceneBatch`）。
7. **统一跨子系统基座**：抽公共 `WorkerChannel`（plain data/version/transferables/AbortSignal/latest-wins/bounded queue/故障退役），消除 glTF/Spine/assets 三处 worker seam 漂移与 `createAbortError` ×5；统一序列化版本策略；补齐各目录 `index.ts` barrel 一致性；给 compute 加显式 barrier 契约。
8. **把"门禁脚本"从负向约束升级为正向契约**：`modules:check`/`responsibilities:check` 目前靠字符串/路径规则（黑名单），建议把 `Render3D*` 职责边界提炼成显式接口（如 `FrameCoordinator` 只输出 frame items，`Submitter` 只消费 frame items），用类型而不是脚本表达"谁不能 import 谁"。
9. **shader-language 减负**：评估把 GLSL ES300 降级为可选 lint 工具或移除，聚焦 WGSL；把 IR 节点/变体预算门禁从手动记账进化为 CI 自动 baseline diff。
10. **渲染侧引入 worker 或 WASM 批量化**：优先落地 WASM culling/transform（todos 已有方案与实测），threads 作为二期。
11. **修复文档编码 + 清理手写 shader escape hatch**：把 GBK 乱码 README 转正；给 migration manifest 剩余手写 shader 排期迁入 `shader-language`。

---

## 8. 结论

这个引擎的**能力广度与工程纪律是顶级的**：责任分解、上传去重、缓冲生命周期、正确性优先的透明合批、revision 门控、设备恢复、能力协商、API 稳定性分层——这些都被行级证据坐实，不是文档自夸。

它的主要机会成本不在功能覆盖，而在**架构收敛与可演进性**：

- **生产 shader 面整体绕过 Typed IR**（手写 WGSL + 手维护反射表 + `.replace()` 绑定重映射 + 双 artifact 版本）——这是最核心、最该优先治理的一条。
- **3D 渲染器近重复**（可参数化收敛数千行）+ 两条真实风险（深度量化不一致、异步贴图 use-after-destroy）+ 若干占位/死代码。
- **跨子系统底层一致性薄弱**（worker 协议、abort 错误、序列化版本、生命周期基座各自长成）。
- 明确的补全缺口：WASM 数值内核、文本/MSDF/Markdown 渲染、渲染侧并发、数据导向 ECS、以及正式发布设备证据。

下一阶段的重点应是把"负向门禁"变成"正向架构"，并优先补上生产 shader 回归 Typed IR、渲染器去重、跨子系统共享基座这三块最明确的架构债。

---

## 附：主要引用文件

- ECS：`engine/src/ecs/{World,Entity,Component,System,Query}.ts`
- 生命周期/设备恢复：`engine/src/core/{Engine,Lifecycle,FrameLoop}.ts`
- 渲染调度：`engine/src/renderer/{RenderPipeline,RenderIntegration}.ts`、`engine/src/core/{RenderCommandContext,RenderGraph,RenderView,RenderProfile}.ts`
- 帧架构：`engine/src/frame/FrameData.ts`
- 3D 渲染：`engine/src/systems/Render3D*.ts`、`engine/src/renderer/{Mesh3DRenderer,PbrRenderer,BlinnPhongRenderer,ToonRenderer,RendererObjectTable,SceneFrameGpuArena,GpuDrivenBatchBuffer,TransparentMegaBatch,FrameRingResource}.ts`
- 材质：`engine/src/material/{PbrMaterial,MaterialDescriptor}.ts`
- 物理：`engine/src/physics/{Physics2DBackend,Physics3DBackend,Box2DPhysics2DBackend,RapierPhysics3DBackend,Physics2DSystem,Physics3DSystem}.ts`
- shader 编译：`shader-language/src/{ir/*,backend/*,adapter/precompiled-v2.ts,material/*,graph/*,deformation/*,postprocess/*,compute/*}`、`shader-language/{shader-cost-budgets.json,migration-manifest.json,escape-hatches.md}`
- 运行时 artifact 契约：`engine/src/shader/PrecompiledShaderRuntime.ts`、`engine/test/precompiled-shader-runtime-v2.test.mjs`
- 计算/GUI/资产：`engine/src/compute/*`、`engine/src/gui/*`、`engine/src/assets/*`
- 已知待办：`todos/WASM_PERFORMANCE_PLAN.md`、`todos/MARKDOWN_MSDF_RENDERING_PLAN.md`
