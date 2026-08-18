# Runtime convergence owner matrix

| 领域 | 当前 owner / consumer | 已确认重复或缺口 | 冻结后的唯一 owner | Goal |
| --- | --- | --- | --- | --- |
| Shader authoring source | `shader-language/src/*/stdlib` + family definitions；generator 消费 | WGSL 与 reflection 可分别修改，material-lighting 还做 binding replace | family source + compiler validator；同次生成 WGSL/reflection | G02 |
| Artifact schema | `shader-language/src/adapter/precompiled*.ts` 与 `engine/src/shader/PrecompiledShaderRuntime.ts` | V1/V2 reader/writer、V2 类型双声明 | shader-language schema 生成 private engine declaration；production V2 only | G02 |
| Shader target/cost | WGSL production、GLSL Stage 14、`shader-cost-budgets.json` | GLSL 结论不清，cost diff 依赖手工看 baseline | GLSL portability verifier；自动 cost diff | G02 |
| Logical pass plan | `RenderGraph` 与 Render3D frame planners | 与 RenderPipeline 的排序/资源职责未由类型连接 | RenderGraph/typed plan compiler | G03 |
| Pass execution | `RenderPipeline`、`RenderCommandContext` | target identity 恒 true，诊断可能不等于执行 | RenderPipeline submitter + resource resolver | G03 |
| Object slot/table | 八类 3D renderer | object state、slot、dirty/flush 近重复 | parameterized renderer core | G04 |
| Geometry/cache/upload | 八类 3D renderer | geometry version、buffer replacement、retirement 近重复 | renderer core；特殊 vertex/resource policy 注入 | G04 |
| Transparent depth policy | `TransparentMegaBatch`、GPU-driven batch builder | `×1024` 与 `×16` | shared typed quantizer | G04 |
| Renderer async/scratch | Mesh texture loader、Render3D record contexts | destroy 后迟到写回；跨 view mutable singleton | renderer owner generation/abort；call-scoped scratch | G04 |
| Worker transport | engine assets/KTX2/CSG、extensions glTF/Spine | envelope、fault、abort、queue 分裂 | engine private versioned WorkerChannel | G05 |
| Async primitives | AssetJob/scheduler/loaders/extensions clients | abort、priority、clock 重复 | engine private async helpers | G05 |
| Asset phase | AssetJob + AssetManager direct field | phase/event 可绕过 | AssetJob method | G05 |
| Compute ordering | compute pass callers + handwritten assumptions | storage→indirect dependency未表达 | typed compute sequence/validator | G06 |
| Compute GPU resource | Artifact runtime、processor instance | review 错把不可销毁 pipeline/layout 当泄漏；device/recovery owner仍需明确 | device cache + processor buffer/texture owner | G06 |
| GUI vertex layout | batch packer + renderer descriptors | 15/12 float 与 stride/offset 双写 | typed GUI vertex descriptor | G06 |
| GUI serialization | `GuiSerialization` | 无 format/version，输入验证不足 | versioned schema + unknown validator | G06 |
| GUI sampler/lifecycle | image/text renderer | sampler 每次创建且 owner/recovery 不清 | renderer/device-scoped sampler owner | G06 |
| Scene numeric batch | object ECS path；旧 WASM benchmark | 无生产 SoA seam，旧数据未包含完整同步成本 | optional SceneBatch oracle；WASM 需过保留阈值 | G07 |

## Dependency direction

`shader-language` 不进入 runtime。Engine 不依赖 extensions。Extensions 只能从 engine 声明的 focused package export 消费共享 async plain contract。Renderer core 不导入 Render3D facade；frame coordinator、plan compiler、submitter 与 resource owner 保持单向数据流。
