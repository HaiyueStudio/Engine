# Engine 0.2.1 G01：合同与基线验收

日期：2026-09-25。状态：blocked（设备限速、稳定基线待完成）；不得据本页认定 G01 完成或启动 G02。

## 阅读顺序

1. [ADR 0109](../../docs/for-ai/adr/0109-deferred-lighting-021-contract.md)：Deferred/Tiled、ABI、材质、资源和失败行为。
2. [机器合同](../../config/lighting-performance-021.json)：命名案例、精度、内存与待冻结的设备绝对时延预算。
3. [上游固定参考](./upstream-reference.json)：官方示例的 commit、文件哈希与许可证。
4. [消费方版本观测](./consumer-versions.json)：manifest/lockfile 哈希及实际解析值。

## 当前证据与限制

源码观察点仍为 `365552908414ffa193c63a62aaf682f4ddb23b94`。G01 不改生产 renderer、generated Shader、公开 API 或包版本；新增代码是基线采样/验证及格式探测设施。测量绑定运行时源码、实际 dist、采样脚本与 HTTP 文件哈希；带 G01 未提交变更的诊断数据不冒充 clean-release 正式证据。

- 本机实测适配器为 AMD `rdna-1` 与 Intel `gen-9`，分别由 Chrome high-performance / low-power 请求选中，均 `isFallbackAdapter=false`、支持 timestamp-query。它们是同一 Intel Mac 上的独显/集显两个硬件类别，不是两台机器或手机验收。
- [设备探测](../../artifacts/engine-0.2.1/g01/adapters.json) 记录 adapter limits 与实际选择；生产准入仍须检查 requestDevice 后的 device limits。
- [G-buffer 探测](../../artifacts/engine-0.2.1/g01/gbuffer-probe.json) 在两个实际 device 上通过三个 rgba16float + depth32float 的渲染/读回；normal 角误差约 0.0076°，没有 validation error。它证明格式与量化可用，不证明 Deferred 场景、带宽或性能通过。
- 当前 Forward 与 GPU 实例的完整三轮诊断采样已完成：两类适配器 × 五类场景 × 三轮，共 30 项；每轮保留 300 CPU / 300 GPU 原始样本，每组合汇总 900 样本。独立校验确认采样、实际设备、场景与 HTTP 输入完整性通过。
- [独立验收结果](../../artifacts/engine-0.2.1/g01/completion-check.json) 显示其他任务自然结束后的第二次完整采样仍有 9/10 个设备/场景组合未通过跨轮稳定性要求（P95 相对极差 ≤ 20%、CV ≤ 10%）：8 项 CPU、6 项 GPU 超标。仅 Intel 10k 实例同时满足两条要求。本轮仅保留诊断证据，绝对 CPU/GPU 预算仍未冻结。
- CPU 指标保持独立：灯光场景为 runtime frame，GPU 实例场景汇总为 cpuRecord；后者的 cpuSubmit、frameWall、queueWait 在原始报告中分别保留，不能与 cpuRecord 混称完整帧时延。

## 源码复核分类

| 项目 | 分类 | 依据与处理 |
| --- | --- | --- |
| 8 灯 Forward 与 3 方向阴影 | still-current | SceneLightData、SceneLightSelection、ViewLightUniformBuffer；G02 从未截断源集取灯 |
| 辅助 MRT、frame graph、target pool | still-current | Render3DFramePlan/RenderGraph/TransientRenderTargetPool；扩展已有 owner |
| GpuPassProfiler 与异步 readback | still-current | 复用 timestamp 计时与迟到/取消语义，正常帧不读回全部实例 |
| GPU instance / LOD / 外部 visible ID | still-current | ADR 0108 及既有专项；本轮测静态外部矩阵 + LOD/indirect，动态模拟和四视图仍由 G05 完整验收 |
| 0.2.0 AO、Shader/示例预算与发布问题 | already-fixed | `review/release-0.2.0-global-check.md` 记录旧冻结候选通过，不重新标成未修 bug |
| Deferred/storage lights/Tiled/完整透明 PBR | new-work | ADR 0109；当前没有生产实现，不由本轮探测冒认完成 |
| 字体同步解析器传递成本 | deferred | AnimationTextRasterizer 仍静态 import opentype；历史配对约 98 KB，先独立评估入口/兼容收益，不实施 |
| Spot/局部阴影/CSM/3D Clustered/Hi-Z/Rust | deferred | 各自准入；Forward+/CSM 现有策略不解除 |

## 上游与许可证

参考官方 webgpu-samples 固定 commit `e040ec1a20dbbe01afed30c812e825b2639cfe5b`，默认 128 灯、最大 1024；compute 更新位置，fragment 仍遍历所有灯。G01 只记录设计参考与哈希，没有复制生产代码或 dragon mesh。

上游为 BSD-3-Clause：后续如复制/改编源码，保留版权、条件及免责文字；二进制发布资料也需携带相应 notice；不得以作者名背书。许可证文件的固定 URL/hash 见上游记录。任何模型资产需要另查其许可，不能把代码许可证外推给资产。

## 消费与发布边界

Engine 四库源码为 0.2.1，Editor/Games 当前 lockfile 中 Engine 仍为 0.1.0；AIStudio 使用本地已打包 0.1.0 变体，Native 示例也使用 vendor tarball 0.1.0。它们不是同一内容，仅版本字符串不足以证明兼容，详见哈希化 census。

UI 没有 Engine 依赖。G01 仅登记 Engine 独立 candidate line，保留协调仓 0.1 消费范围和各消费仓 lockfile，不要求 UI/Editor/AIStudio/Games/Native 升级或参与 Engine gate。Games 实际还有 UI 依赖，与协调仓原依赖政策不同；作为现存差异记录，不在本 Goal 顺带修改该仓架构。

## 过程记录

- 首次 `npm run build:engine` 在本机多个 Rust/Swift 编译并行时触发原 120 秒超时；同命令/原阈值重试成功（Rollup 约 76.9 秒）。没有终止其他任务。
- 第一次采样冒烟在无完整 dist 时失败；后来一次因编写其他采样输入触发 source fingerprint 变化而失败。保留日志，这些失败不计为性能样本或通过证据。
- 再次冒烟发现 dist 文件枚举顺序不稳定导致指纹误报；现统一排序、去重，并加入针对遍历顺序的测试。完整四项双适配器冒烟已通过（`smoke/summary.json`），这仍不是性能基线。
- 第一轮完整诊断采样绑定 1,964 项输入快照，期间输入未变；采样后才调整候选合同的 per-view ambient header（32 字节）和独立校验脚本。第一轮全部结果、输入、合同和校验结果已保存在 `artifacts/engine-0.2.1/g01/attempt-1-contended/`。
- 按用户选择等待 `scene-desktop` 与编译任务自然结束，没有终止其他任务。随后重跑全部 30 项，运行器自动保存新的输入与合同快照。开始、中途和结束时的只读进程检查未再发现上述渲染/编译进程；这不证明所有系统干扰都消失。第二轮实际浏览器加载的字节校验通过，结果位于 `baseline/`。
- 第二次采样的独显四视图 GPU P95 为 10.125/10.124/5.982 ms，CPU 为 8.480/5.420/5.865 ms。不能挑选最快轮次，也不能再直接把波动归因于已结束的任务。没有采集温度或频率传感器，热状态、调度和运行时预热只能作为待检验假设。
- 后续只读检查获得新的系统证据：2026-09-25 12:39–12:42（UTC+8），`pmset -g therm` 连续报告 `CPU_Speed_Limit=33/33/26`、scheduler limit 100、12 个可用 CPU，电源已接入。无 thermal warning 不等于没有 CPU 限速。这不能反推之前每一帧的频率或证明唯一根因，但当前限速足以阻止再次采样。见 [主机状态](../../artifacts/engine-0.2.1/g01/host-readiness.json)。
- 采样工具新增 `--host-check`，只检查主机，不运行浏览器或覆盖旧基线；当前按预期退出 1。完整采样前及每项前后均保存并解析系统状态，限速或证据缺失则拒绝冻结；早期两轮没有这项同步证据，不能补造。此检查是当前固定 Mac 主机的诊断准入，不是跨平台产品硬依赖，也不保证两次观测之间没有波动。
- 下一步先等待系统 speed/scheduler limit 恢复 100，再诊断预热收敛并按统一协议采集完整三轮；不可通过关闭系统保护、提高预算、删除慢样本或事后混合两次采样来宣布通过。
- 当前检查：G01 策略与主机证据测试 12/12、既有灯光测试 26/26、性能策略测试 122/122、docs:check、api:check 与协调仓 check 均通过。首次性能策略测试的 2 项 loopback EPERM 记录保留，获准本地 loopback 后完整重跑通过。
- `node scripts/lighting-g01-check.mjs --require-frozen` 按预期退出 1：数据完整性通过，但跨轮稳定性与绝对预算尚不满足冻结要求。
