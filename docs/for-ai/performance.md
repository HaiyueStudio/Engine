# Performance workflow

先用 `diagnostic` profile 和编辑器诊断面板定位 CPU frame、upload、pass、pipeline/cache 与 GPU 资源 owner，再决定优化层级。不要用单次计时作为结论。

- `npm run benchmark`：report-only 地统计 warmup 后的 P50/P95、标准差、分配量、分阶段预算，以及 readback skip rate、staging 峰值、cache hit rate 和 churn 清理残留等绝对指标预算。
- `npm run benchmark:enforce`（等价于 `node scripts/run-benchmarks.mjs --enforce`）：硬执行绝对 P95、结构 metric 和符合身份条件的相对性能门禁。enforce 固定要求 warmup ≥ 8、samples ≥ 30；降低参数会直接失败。可用 `--case 'render3d.*'`（可重复或逗号分隔）定向运行，但带 case filter 的 artifact 不能作为 release evidence。
- `CPU_BENCHMARK_RUNNER_PROFILE=apple-m4-pro-fixed npm run benchmark:baseline:update`：只在 Node.js 22 或更高版本、已登记 runner、clean worktree 上晋升正式 baseline。命令执行至少 3 个独立完整 full profile 进程，保留每轮证据并按 case 取全部轮次的中位数；不允许 case filter、删异常轮或把普通候选 artifact 直接复制成 baseline。
- `npm run verify:renderer-benchmark`：在当前真实 WebGPU adapter 上执行 256 实体交互帧预算；`--long` 对应 1000 实体 release 负载。
- `npm run verify:planar-reflection`：执行平面反射像素/裁剪/递归/资源语义；4 个黄金预算 case 在 warmup 后以 40 个样本判定 P95，长版额外把其余 44 个组合各真实执行一次，形成完整 48 组合 validation 矩阵。
- `npm run verify:render`：固定 WebGPU 环境像素基线，执行 renderer 与平面反射 P95 预算，并执行 120 帧真实 Chrome readback/churn correctness gate。
- `npm run verify:webgpu-readback:long`：1800 帧真实 Chrome/Metal 长跑，输出 readback latency、ring occupancy、pending destroy、cache hit/miss、GPU 资源峰值与最终残留 artifact。
- `npm run build:target -- example:gpu-driven-megabatch`：大批量参考负载。
- `npm run release:artifact:check`：快速检查 bundle budget、manifest 与声明。
- `npm run release:check:local`：完整正确性门禁加当前物理设备 full evidence。
- `npm run performance:compare`：在当前 native GPU 上运行同机跨引擎 smoke，比较 HaiYue、Three.js、Babylon.js、PlayCanvas，并单列 Galacean WebGL2。
- `npm run performance:compare:full`：执行三轮交错 cohort、结构 parity、独立截图 sanity 和“领先或处于最快 WebGPU 对手 5% 内”门禁。
- `npm run release:check`：全局正式候选门禁；性能部分使用 clean revision 的 portable full comparison，不聚合指定 GPU 型号。

Node 微基准的 artifact 显式绑定 Node/V8、platform/arch、CPU 型号、runner profile、benchmark profile、warmup/samples/iterations、revision 和 dirty 状态。相对性能只在 Node/V8、平台、CPU、runner、profile 与采样配置相同，而且双方 revision 合法、worktree 都干净时才 eligible；不匹配记录为 `ineligible`，不生成 regression。任一 eligible 的相对退化（不因首轮 RSD 较高而跳过）都会按 case filter 启动至少 3 个独立 Node 子进程复验。复验保留每一轮原始 P50/P95/RSD，不剔除最慢轮；最终使用所有轮次 P50/P95 的 cohort 中位数，并要求严格多数轮的 RSD ≤ 10%。单轮尖峰会留在证据中，但只要低噪声轮占严格多数，中位数仍可作决定；噪声轮达到半数或更多时结果为 `revalidation-inconclusive`，enforce 与 release artifact validator 都会失败。亚微秒同步路径和微秒级异步控制路径通过 case-owned measurement window 扩大单个计时区间，harness 仍按操作数归一化为 ms/op；不得通过放宽 RSD 或忽略 noisy round 获得绿色。正式 baseline 自身也必须使用至少 3 个独立、完整 full profile 进程晋升，每个 case 取所有轮次中位数并内嵌逐轮证据，从源头避免把单轮低谷固化为长期门槛。绝对 P95 与结构 metric 不依赖相对比较资格，所有 `check:slow` 环境都通过 `benchmark:enforce` 硬执行。

亚毫秒 case 不允许通过放宽 RSD 阈值“治理”噪声。单次操作接近系统计时、调度或 GC 噪声下限时，case 必须在一个 sample 内执行多个完整操作，再由 harness 归一化为 `ms/op`；当前 ECS query lifecycle 与 hierarchy FrameData 各使用 100 次，KTX2 header 使用 100000 次，glTF sampling 与 asset upload scheduler 各使用 10000 次，普通图片 mipmap 与 Spine timeline sampling 各使用 1000 次，真实 renderer frame 与 16 MiB export writer 各使用 5 次，1K full-prepare 使用 20 次，1K planar-reflection matrix 使用 5 次，RendererObjectTable flush 按 1%/10%/100% dirty ratio 使用 1000/400/50 次，editor play/restart/import 使用 5 次，mock readback ring/staging retirement 使用 50/30 次完整操作的测量窗口。每次迭代仍执行真实状态转换，不能用空循环放大时间。

绝对预算必须按 workload 的实际独立规模维度缩放，不能只按 case 名中的一个维度外推。例如 `frame-data-transform` 的成本同时随 churn cycles 和 hierarchy entities 增长，full profile 把两者各放大 4 倍时，灾难性 hard cap 按 16 倍缩放；同身份 baseline 的 15% 相对门禁继续用于固定 runner 诊断，但不决定跨引擎发布排名。

普通 `ubuntu-latest` slow gate 使用 `github-hosted-ubuntu-latest` runner profile，不能拿 Apple M4 Pro 数值做相对判断；它仍执行完整的绝对/结构预算。旧 `apple-m4-pro-fixed` 流程保留为内部 CPU baseline 校准工具，artifact 继续验证 Node/V8、CPU、runner、full profile、完整 case 集、revision 与 clean 状态。`benchmark-stage9.json` 的同身份相对结果只用于诊断；跨 Node/V8 身份保持 `ineligible`，也不会替代 portable cross-engine release evidence。

真实 renderer 继续使用 [`config/webgpu-performance-budgets.json`](../../config/webgpu-performance-budgets.json) 的分设备绝对 P95 做内部退化诊断。renderer 将单次提交返回前的 CPU runtime、包含采样 fence 的 sample-wall、以及 `queue.onSubmittedWorkDone()` queue-wait 分开，smoke/full renderer 分别采 20/30 个样本，平面反射黄金 case 采 40 个样本。这些预算不会因为缺少某个登记 GPU 而单独阻断发布。

正式渲染性能结论改由 [`performance-comparison/`](../../performance-comparison/README.md) 产生。五个引擎共享 1280×720、DPR 1、256 boxes、3072 triangles、8 PBR materials 和两盏无阴影灯的场景合同；每轮记录 CPU submit 和 GPU completion wall time，并把 adapter/backend/driver/browser/依赖版本写入报告。HaiYue、Three.js、Babylon.js、PlayCanvas 构成 WebGPU 排名，Galacean WebGL2 只作信息对照。结构数量、截图 sanity、native backend、完整三轮 cohort 任一不满足都失败；硬件型号不参与资格判断。10k 实体、深递归平面反射仍是防退化压力预算，不代表跨引擎实时帧率承诺。

平面反射的递归浮点采样在同一 Metal 设备的重复运行中也会出现低位差异，因此整帧 hash 只保留为诊断信号；它不能作为跨设备阻断条件。真正阻断的是画布尺寸、非黑像素（±2%）、平均亮度（±1）、固定采样点通道（±2）以及完整 mirror planner/culling 统计。这样仍能抓黑屏、亮度/轮廓漂移、反射未执行和裁剪回退，同时避免无视觉差异的低位 hash 假红。

资源残留、ring 容量、结果身份、validation error 和 skip rate 使用绝对预算。Node mock 继续负责可控的 ring 饱和与 staging 状态机测试；`check:slow` 的短跑负责真实设备 correctness，固定 `macos-15` Chrome/Metal runner 的长跑负责 1800 帧稳定性证据。readback 结果携带调用方 frame token，迟到结果不会覆盖较新的 last-value cache；销毁中的 MAP_READ buffer 先逻辑取消，等 `mapAsync()` settle 后再 native destroy。新性能场景必须写入 manifest 的 `performance` 字段并给出稳定预算。

灯光与阴影规模化遵循独立的[真实游戏基准协议](./lighting-shadow-scaling.md)。固定灯光上限的 forward renderer 只有在真实游戏证明内容或帧预算受限后，才进入 Forward+/clustered、GPU light list 或 cascaded shadow 原型；mega-batch 微基准不能替代这项证据。
