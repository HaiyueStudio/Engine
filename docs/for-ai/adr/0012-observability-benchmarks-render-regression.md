# ADR 0012：可观测性、统计基准与真实渲染回归

- 状态：Accepted
- 日期：2026-07-13
- 范围：engine、editor、components、CI

## 背景

阶段七之前，海月可以验证类型、模块边界、生命周期、单元测试和 bundle，但无法从一次帧执行回答资源归属、pass 合并原因、CPU/GPU 成本与缓存效率；旧 benchmark 也只有单次耗时。示例成功构建不等于渲染结果正确。

## 决策

1. `GPUResourceTracker` 是 GPU 对象和缓存诊断的唯一来源。资源记录包含稳定 id、类型、label、owner、估算字节、创建帧、最近使用帧；创建栈只在显式开发期开关下采集。
2. buffer、texture、query set 保留始终开启的 ownership 生命周期；sampler、bind group/layout、pipeline layout、render/compute pipeline 与命令计数只在 diagnostics 开启时插桩，避免 production 常态成本。
3. `FrameDiagnostics` 定义统一阶段和计数器。Render3D、RenderPipeline、GPU queue/pass 插桩写入同一帧 snapshot；diagnostics 与 timestamp-query 同时可用时，RenderPipeline 在实际 render/compute pass 创建边界统一注入 timestamp writes，以三槽异步 readback 输出逐 pass 与总 GPU 时间。shared pass 只计一次，结果携带原始 frame id，迟到的旧帧不得覆盖更新结果。
4. `RenderPipeline.getDebugSnapshot()` 同时保存配置意图和上一帧实际组织结果。shared pass 的目标、load/store/depth 必须一致；空 target key、系统越权结束 shared pass、附件状态冲突都成为结构化 issue。
5. 根 benchmark 使用统计 harness。报告固定包含环境指纹、warmup、iterations、样本数、P50/P95、标准差、相对离散度、分配量和 checksum，schema 与 suite 都有版本。
6. benchmark 门禁分两步：`npm run benchmark` 默认 report-only；`npm run benchmark:enforce` 或显式 `--enforce` 硬执行绝对/结构预算，并只对身份一致的证据执行相对门禁。身份包含 Node/V8、platform/arch、CPU/runner profile、benchmark profile、samples/iterations、revision 与 dirty 状态；不匹配时相对比较为 `ineligible`。任一 eligible 回归都由至少 3 个独立进程复验，不允许首轮高 RSD 隐藏回归。cohort 保留全部轮次且用全部轮次的 P50/P95 中位数决策；严格多数轮必须满足 RSD ≤ 10%。少数尖峰不被删除但不单独推翻中位数，多数噪声则判为 `revalidation-inconclusive` 并阻断。GPU 指标只在固定 runner 上比较。
7. 像素回归使用固定 Chrome 参数执行真实 WebGPU render pipeline，读回 `rgba8unorm` 纹理原始字节并与 golden hash、颜色样本和像素计数对比。bundle 构建继续存在，但不再被称作渲染回归。
8. 编辑器 play diagnostics 面板消费结构化 snapshot，展示 frame/pass/draw/dispatch/resource/asset ref/cache/device/issue、GPU 总时间与最慢 pass，并导出带 schema 的 JSON。

## Production 约束

`HaiyueEngine` 的 diagnostics 默认关闭。关闭时不捕获 stack、不包装 pipeline/bind-group/sampler 创建入口、不包装 command pass 或 queue upload；`RenderPipeline` 不创建逐帧 pass/issue trace、timestamp query/buffer、pass key 和 record callback，默认 descriptor cache hit 也不构造 cache 诊断参数。设备不支持 timestamp-query 时同样不得分配 timing 资源。编辑器诊断 UI 继续延迟加载。所有诊断开关必须显式通过 `diagnostics: { enabled: true }` 启用。

## 验证

- `npm run observability:check`
- `npm run benchmark`
- `npm run benchmark:enforce`
- `node scripts/run-benchmarks.mjs --enforce --case 'render3d.*'`（定向诊断，不能生成 release artifact）
- `npm run verify:pixels`
- `npm run check:slow`

阶段七的数值与环境记录见 [`review/baselines/stage-7-observability-performance-2026-07-13.md`](../../../review/baselines/stage-7-observability-performance-2026-07-13.md)。
