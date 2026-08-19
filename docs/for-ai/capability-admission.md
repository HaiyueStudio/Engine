# 大型能力准入

M2.5 明确暂缓的能力与所需真实证据登记在 [`runtime-convergence/deferred-capabilities.md`](./runtime-convergence/deferred-capabilities.md)。该 registry 只引用本准入流程，不降低下述 policy 阈值。

大型渲染、导航和平台后端会改变长期架构、Shader ABI、资源生命周期、编辑器诊断和设备验证成本。HaiYue 不以“能力列表更长”为理由启动这类工作；必须先用真实产品内容证明当前实现构成实际阻塞。

## 当前决策

| 能力 | 当前状态 | 独立证据 |
| --- | --- | --- |
| WebGPU compute ray tracing | hold | path tracing、ray shadow、ray reflection 与 ray AO 各自需要真实产品 scene/camera、当前路径 baseline 和独立 reference |
| Forward+/Clustered | hold | 真实画面必须同时需要超过 8 盏灯；沿用 lighting policy |
| CSM | hold | 长视距室外画面必须证明单 shadow map 无法兼顾近景质量和远景覆盖 |
| WebGL2 fallback | hold | 产品覆盖率或强制目标平台必须证明 WebGPU-only 阻塞发布 |
| 分层 NavMesh | hold | 真实路线必须包含同一 X/Z 上的洞穴、叠层桥梁或隧道上下表面 |
| clipping cap | hold | CAD、编辑器剖切或游戏 cutaway 必须需要闭合截面 |
| Instanced clipping | hold | 至少 1000 实例的真实场景必须需要实例级裁剪语义 |
| Line clipping | hold | 真实 CAD、gizmo 或 cutaway 必须证明线渲染缺少裁剪 |
| PlanarMirror clipping | hold | 真实镜面/传送门内容必须证明反射视图需要一致裁剪 |

`hold` 不是“以后一定实现”，也不是实现缺陷；它表示尚无足够证据承担长期复杂度。当前的单层 Y-up NavMesh、多平面片元裁剪和 WebGPU-only 产品边界仍是刻意设计。

## 准入流程

1. 在真实游戏、编辑器工作流或目标产品中发现当前能力不足。
2. 固定内容来源、场景哈希、相机或路线 replay，并记录当前路径的可复现 deficit。
3. 按 `config/capability-admission-policy.json` 生成独立证据。灯光与 CSM 继续使用 `config/lighting-architecture-policy.json`，不复制口径。
4. 运行 `npm run capability:admission:check`。证据只有完整且没有未分类失败时才会得到 `eligible-for-prototype`。
5. 评审证据后，将对应 policy 的 `decision` 从 `hold` 改为 `prototype-approved`。缺少证据却修改 decision 会让 fast/release gate 失败。
6. 原型仍不能直接成为稳定 API。原型完成后必须新建 ADR，并补 correctness、设备、性能、包体和迁移证据。

证据文件可以在采集中保持未登记；正式写入 policy 指定路径后必须使用对应 schema，且 `unclassifiedFailureCount` 必须为 0。Synthetic mega-benchmark 可以辅助定位成本，但不能代替真实内容要求。

## 证据边界

### WebGL2 fallback

需要至少 28 天、1000 个 session 的覆盖率数据且 WebGPU 不可用比例达到 5%，或存在明确的强制目标平台；还需要至少三个固定场景、两个设备类别以及 golden path、PBR、资产加载的最低 parity 范围。Shader Language 的 GLSL ES 300 后端可行性不能单独解锁 fallback。

### WebGPU compute ray tracing

Ray tracing 必须为 `path-tracing`、`hybrid-shadow`、`hybrid-reflection` 和 `hybrid-ao`
分别登记一组真实产品 case。每组 case 固定 source product、scene、camera replay、scene hash、
当前 raster/screen-space baseline 图像、独立 reference 图像和真实 device class，并证明当前路径确实
无法表达登记的 deficit。相同 baseline/reference、示例性质的 synthetic triangle/ray workload、仅有
性能推测或单纯功能愿望都不能解锁原型。完整 schema 与冻结的实现边界见
[Ray tracing contracts](./ray-tracing/README.md)。

### 分层 NavMesh

当前高度场已经支持表面缺口，但不能在同一 X/Z 表示多个可走高度。证据必须包含 cave、stacked bridge 或 tunnel underpass 的固定路线，至少两个重叠表面，并证明现有 heightfield 无法表达该路线。普通地面洞口不能解锁分层 backend。

### 裁剪扩展

caps、InstancedMesh3D、Line3D 和 PlanarMirror 拥有不同的几何、实例、线段和反射语义，因此分别审批。普通 Mesh3D 的片元裁剪像素结果不能作为它们的替代证据，也不能一次证据同时解锁多个 renderer。

## 门禁

- `scripts/capability-admission-policy.test.mjs` 验证 schema、独立解锁和错误归因。
- `scripts/check-capability-admission.mjs` 同时消费通用 policy 与现有 lighting policy。
- `check:fast` 显式运行统一 checker；local/global release 通过 fast gate 自动继承。
- `npm run lighting:architecture:check` 保留为灯光专项诊断入口。
