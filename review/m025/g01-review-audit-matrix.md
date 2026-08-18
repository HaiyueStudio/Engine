# M2.5 G01 review audit matrix

复核 source revision：`04696d815265bb384119f25cd7d825e5977b1960`。DeepSeek review 是输入而非证据；分类只使用 `confirmed`、`already-fixed`、`covered-by-m02`、`covered-by-m03`、`m025-goal`、`deferred-capability`，其中 `confirmed` 行同时给出最终处置，避免遗留 `unclassified`。

权威合同：[M2.5 contracts](../../milestones/m025-engine-runtime-convergence/contracts.md)、[ADR 0074](../../docs/for-ai/adr/0074-pre-release-runtime-convergence-sequencing.md)、[owner matrix](../../docs/for-ai/runtime-convergence/owner-matrix.md)、[deferred registry](../../docs/for-ai/runtime-convergence/deferred-capabilities.md)。

## §5 缺点与风险

| Review item | 分类 | 当前源码复核 | 处置 |
| --- | --- | --- | --- |
| 5.1-A production family 使用 WGSL module + reflection definitions | confirmed / m025-goal | `shader-language/src/material-lighting/definitions.ts` 等仍同时登记 source 与 reflection | G02；ADR 0075 |
| 5.1-1 binding `string.replace()` | confirmed / m025-goal | `material-lighting/definitions.ts:40-43` 仍替换 group/binding | G02 删除 |
| 5.1-2 variant 预算 56/58 | confirmed / m025-goal | `shader-language/shader-cost-budgets.json` baseline 56、上限 58 | G02 自动 diff；不放宽预算 |
| 5.1-3 Motion Blur V1、其余 V2 | confirmed / m025-goal | postprocess program/family 仍 `version: 1`；runtime 同读 V1/V2 | G02 迁 V2 并删 V1 writer/reader |
| 5.1-3 compiler/engine V2 类型重复 | confirmed / m025-goal | `adapter/precompiled-v2.ts` 与 `PrecompiledShaderRuntime.ts` 各有完整声明 | G02 生成 private runtime type |
| 5.1-4 GLSL 覆盖不足且结论不清 | confirmed / m025-goal | Stage 14 仍明确排除 compute/storage/MRT/production degradation | G02 按 ADR 0075 保留 optional portability verifier |
| 5.1-5 render IR 与 ComputeEffectIr 分离 | confirmed | 两者输入/副作用模型不同；不能只因名称不同判定重复 | ADR 0075 保留 specialized compute IR，G02 只收敛 schema owner |
| 5.1-6 authoring IR node/operation budget有限 | confirmed / m025-goal | showcase 64/60，portable subset 有意受限 | G02 自动报告；无产品 deficit 时不扩语法 |
| 5.2-1 八类 renderer 近重复 | confirmed / m025-goal | object table、geometry cache、write/prepare/flush 在多个 renderer 重复 | G04 parameterized core |
| 5.2-2 test seam / telemetry mirror | confirmed / m025-goal | Render3D 内部访问器和 telemetry binding 仍存在 | G03 建正向类型，G04 删除不再需要 seam |
| 5.2-2 `hasSameRenderTarget()` 恒 true | confirmed / m025-goal | `RenderPipeline.ts:585-587` | G03 实际 resource identity |
| 5.2-2 transparent orchestrator 空 destroy | confirmed / m025-goal | 方法仍为空；当前类无 GPU owner但保留误导 lifecycle | G04 删除或使 owner 明确，不伪造释放 |
| 5.2-2 depth-prepass 不可达分支 | confirmed / m025-goal | 当前路径保留多套 depth-prepass condition | G04 用 fixture 删除不可达分支 |
| 5.2-3 depth quantization 不一致 | confirmed / m025-goal | `TransparentMegaBatch` 与 GPU-driven builder 分别使用不同精度 | G04 shared quantizer + parity |
| 5.2-4 Mesh async texture late write | confirmed / m025-goal | `_loadTextureAsync` 只校验 source identity，destroy 没有 generation guard | G04 abort/generation owner |
| 5.2-5 每 view 重算 postprocess/jitter/camera frame | confirmed / m025-goal | `Render3DSystem` plan sizing 与 `_recordView` 各计算一次 | G04 缓存不可变 frame extraction |
| 5.2-6 跨 view mutable scratch | confirmed / m025-goal | `_materialRenderContext` 等为实例级可变对象 | G04 call/view-scoped reset/reentrancy |
| 5.2-7 透明合批收益有限 | deferred-capability | 当前仅在不破坏排序时合批，正确性合同成立 | 透明实例合批扩张保持 hold |
| 5.3 motion vector 仅 opaque 起步 | deferred-capability | auxiliary buffer 注释与路径仍是 opaque-first | 保持 hold，不作为 G04 去重范围 |
| 5.3 PointLight 无 shadow | deferred-capability | shadow owner仍只消费 DirectionalLight | capability admission 后另立 Goal |
| 5.3 GPU cull readback 仅 telemetry | confirmed | 当前命名、diagnostic 与测试均按 telemetry 消费 | G04 明确边界；遮挡反馈保持 hold |
| 5.3 透明实例合批仅 additive Basic | deferred-capability | `canBatchSortedTransparent` 仍保护 depth semantics | hold |
| 5.3 transmission 只采一层 scene color | deferred-capability | 当前 PBR transmission 合同就是单层 | hold |
| 5.3 target conflict 未完成 | confirmed / m025-goal | 与 `hasSameRenderTarget` 占位相同事实 | G03 |
| 5.4 Compute storage→indirect 责任未表达 | confirmed / m025-goal | dispatch callers 依赖录制顺序，无 typed dependency | G06 ordering descriptor/validator |
| 5.4 Compute stage magic `4` | confirmed / m025-goal | `ComputePassBase.ts` 仍导出常量 4 | G06 平台常量/typed descriptor |
| 5.4 TextureConvolution pipeline/layout “泄漏” | confirmed（建议不准确） / m025-goal | 只销毁 params buffer；WebGPU pipeline/layout 本来没有 `destroy()` | G06 明确 device cache/reference/recovery owner；不调用不存在 API |
| 5.4 TextureConvolution 仅 rgba8unorm | confirmed | 当前精确抛 `E_COMPUTE_INVALID_PARAMETER`，不是静默 fallback | G06 从 descriptor 派生；不扩格式除非有 consumer |
| 5.4 GUI element fields 无显式类型 | confirmed / m025-goal | `GuiElement.ts:27-30` 仍依赖 constructor inference | G06 显式 typed layout model |
| 5.4 GUI sampler owner缺失 | confirmed / m025-goal | text/image renderer 创建 sampler，destroy 无 owner reference | G06 renderer/device owner |
| 5.4 GUI serialization 无版本且值塌缩 | confirmed / m025-goal | `GuiSerialization.ts` 无 format/version 的 unknown schema | G06 versioned payload/validation |
| 5.4 GUI 15/12 float layout双写 | confirmed / m025-goal | packer 与 `arrayStride: 60`/对应 attributes 分离 | G06 typed descriptor |
| 5.4 AssetManager 直接写 jobState | confirmed / m025-goal | `AssetManager.ts:667` | G05 AssetJob single owner |
| 5.4 scheduler `budget===0` break | confirmed / m025-goal | `drainFrame` 前置 return 后仍有该分支 | G05 删除并加 scheduler fixture |
| 5.4 `parseAssetWorkerFirst` 无消费者 | confirmed / m025-goal | 仅定义/export，KTX2 自建流程 | G05 迁移或删除 |
| 5.4 abort/priority/clock 重复 | confirmed / m025-goal | engine assets 与 glTF/Spine 多处重复 helper | G05 private async helpers |
| 5.4 AssetWorkerClient 无 fault retirement | confirmed / m025-goal | 无 `error/messageerror`，KTX2 client 有 `failWorker` | G05 WorkerChannel |
| 5.4 KTX2 worker self import | confirmed / m025-goal | worker source/URL 工厂仍导入 engine 自身路径 | G05 拆 capability worker entry |
| 5.4 assets 无目录 barrel | already-fixed | stable `/assets` 与 experimental assets 已由 focused entry 文件导出；物理 `index.ts` 不是边界本身 | 不为目录对称新增聚合入口 |
| 5.5-1 object ECS 对高数量不友好 | confirmed / m025-goal | World/Entity 仍是 Map/Set 对象模型 | G07 optional derived SceneBatch，ECS 语义不变 |
| 5.5-2 renderer 单线程 | deferred-capability | 事实成立，但没有产品 long-task/部署证据 | threads hold；G07 只测 batch/WASM |
| 5.5-3 M02 no-go 细节 | covered-by-m02 | review 引用旧报告；当前 Windows Chrome/Edge/HYA/发布演练已重放，但正式设备矩阵仍不完整 | M02 最终 RC 重验，不纳入 M2.5 evidence |
| 5.5-4 README 编码 | already-fixed | 当前 UTF-8 中文可读，docs gate 消费正常 | 无 M2.5 工作 |
| 5.5-5 Node mock 与真实 WebGPU 差异 | covered-by-m02 | M02 已有真实 Chrome/Edge full 与 shader/product/WebGPU gates | M2.5 每个 GPU 改动仍运行 focused real case |

## §6 需要补全的能力

| Review item | 分类 | 处置 |
| --- | --- | --- |
| 6.1 WASM 数值内核 | m025-goal | G07；必须满足 ADR 0079，否则 no-go 并删除 runtime |
| 6.2 Markdown/MSDF | deferred-capability | hold；旧 todo 不是 admission evidence |
| 6.3 full shaping/i18n | deferred-capability | hold |
| 6.4 renderer/simulation Worker | deferred-capability | threads hold；G05 只统一 asset Worker substrate |
| 6.5 SoA storage | m025-goal | G07 只允许派生 SceneBatch，不替换 ECS |
| 6.6 release evidence | covered-by-m02 | M02 G02/G04/G07；不复制正式数值 |
| 6.7 scheduling convergence | m025-goal | G03；ADR 0076 |
| 6.8 geometry LOD streaming/memory tiers | deferred-capability | hold；G05 不扩产品能力 |
| 6.9 audio system | deferred-capability | hold |
| 6.10 GLSL decision | m025-goal | G02；ADR 0075 已定为 optional portability verifier |
| 6.11 transparent capability expansion | deferred-capability | hold；G04 只修 parity/lifecycle |

## §7 优化建议

| Review item | 分类 | 处置 |
| --- | --- | --- |
| 7.1 shader 双轨治理 | m025-goal | G02 |
| 7.2 scheduling 分层 | m025-goal | G03 |
| 7.3 renderer core 去重 | m025-goal | G04 |
| 7.4 transparent quantization + late texture | m025-goal | G04 |
| 7.5 target/no-op/dead cleanup | m025-goal | G03/G04 |
| 7.6 optional SoA | m025-goal | G07 |
| 7.7 Worker/async/serialization/compute substrate | m025-goal | G05/G06；assets barrel 建议已否决 |
| 7.8 negative gate → positive types | m025-goal | G03/G04，脚本继续作补充 |
| 7.9 GLSL 减负 + cost diff | m025-goal | G02；GLSL 不进入普通 production path |
| 7.10 WASM before threads | m025-goal + deferred-capability | G07；threads hold |
| 7.11 README encoding + shader escape hatch | already-fixed + m025-goal | README 已可读；G02 收敛 production source，CustomPass raw WGSL 仍为登记 escape hatch |

## 结论

§5–§7 无未分类项。确认的内部债全部归入 G02–G07；M02/M03 已拥有的事项不重复实现；新增产品能力全部进入 deferred registry。评审中“pipeline/layout 必须 destroy”和“目录必须有 index barrel”两条建议经 WebGPU/API 边界复核后不作为实现目标。
