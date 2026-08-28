# Rive production differential adapter

G11 的 production runner 不内置或模拟 Rive/HYA 两端结果。三个 revision-pinned 可执行宿主通过 `haiyue-rive-production-adapter@1` 协议接入：

| Host | Required environment |
| --- | --- |
| capability evaluation | `RIVE_CAPABILITY_EVALUATOR_COMMAND`、`RIVE_CAPABILITY_EVALUATOR_DESCRIPTOR_JSON` |
| official `@rive-app/webgl2@2.40.0` / WebGL2 capture | `RIVE_OFFICIAL_CAPTURE_COMMAND`、`RIVE_OFFICIAL_CAPTURE_DESCRIPTOR_JSON` |
| exact-HYA / WebGPU capture | `RIVE_HYA_CAPTURE_COMMAND`、`RIVE_HYA_CAPTURE_DESCRIPTOR_JSON` |

每类 host 可选 `*_ARGS_JSON`、`*_TIMEOUT_MS` 和 `*_MAX_OUTPUT_BYTES`。command 直接执行，不经过 shell。stdin 是单个 JSON envelope；`Uint8Array` 编码为 `{ "$haiyueBytesBase64": "..." }`。host 必须返回相同 `protocol`、`operation`、完整相同的 `descriptor`、`status: "completed"` 和 `result`。capture result 的 `artifactBytesByPath` 是 `[path, bytes]` 数组。

bridge 拒绝 descriptor substitution、重复 artifact path、cycle、abort 后结果、timeout、非零退出、无效 JSON 与超过上限的 stdout。runner 随后独立重算 11 个 channel comparison；host 的 pass/fail 结论不被直接信任。

仓库内 `rive-production-host.mjs` 是通用 stdin/stdout gateway。capability provider 导出 `evaluate(request, context)`；official/HYA provider 导出 `capture(request, context)`。provider 必须是设备侧实际 full-fidelity evaluator 或 native browser capture 实现，不能使用同一份 mock channel 填充两端。gateway 的 identity 握手把 capability adapter revision 绑定到 gateway bytes、evaluator revision 绑定到 provider bytes，并把 capture revision 绑定到各自 provider bytes。

仓库现已提供三个实际设备入口：`rive-production-capability-provider.mjs` 将全部 Neutral IR 字段保存在 HYA core metadata、映射 canvas/transform，并通过 importer 的受预算 official-evaluator 钩子重新取得已校验 embedded asset bytes，按 Neutral resource 的 SHA-256/长度/MIME 精确映射到 HYA package；两个 capture provider 分别启动固定的官方 WebGL2 和 exact-HYA WebGPU 页面。capture 入口还固定 common host、页面 bundle、shared Engine 以及官方 JS/WASM 的内容哈希；任一传递依赖变化都会在 browser 启动前失败。可用以下命令生成单一 host 配置：

```powershell
npm run rive:g11:host-config -- --capability-provider=scripts/hya-corpus/rive-production-capability-provider.mjs --official-provider=scripts/hya-corpus/rive-production-official-provider.mjs --hya-provider=scripts/hya-corpus/rive-production-hya-provider.mjs --out=artifacts/rive-g11-formal/host-config.json
$env:RIVE_PRODUCTION_HOST_CONFIG_PATH = 'artifacts/rive-g11-formal/host-config.json'
npm run rive:g11:host-preflight -- --config=artifacts/rive-g11-formal/host-config.json --out=artifacts/rive-g11-formal/host-preflight.json
```

也可以继续直接设置六个 `*_COMMAND`/`*_DESCRIPTOR_JSON` 变量。设置 `RIVE_PRODUCTION_HOST_CONFIG_PATH` 后，配置文件中的 host command/args/descriptor 是权威值，不会被进程里遗留的同名变量覆盖；配置未声明的 timeout/output 上限仍可由环境设置。preflight 与 formal closure 都会真正启动三个 command 执行 `identity`，并核对 kind 与 revision，不再只检查字符串非空。provider entry 应是自包含的设备侧 bundle；descriptor 固定的是该 bundle 的实际 bytes，不能把可变源码入口或未固定的远程服务地址作为 provider revision。

正式 environment JSON 还必须记录 `browserLogCaptured: true`、`consoleErrorCount: 0` 与 `exceptionCount: 0`。official 与 HYA capture provider 都必须返回完整且完全相同的 environment；它又必须与 runner 请求一致，否则 runner 在生成 trace 前失败。这三项进入 trace formal contract，index collector 才能从 trace 机械生成 device/browser evidence，不能人工补写零值。trace 同时永久记录 capability、official capture、HYA capture 三个 descriptor。

正式收集顺序：

1. 在 Node.js 22 或更高版本、clean Engine revision 上配置三个 host；优先使用上述生成配置。正式闭环会对三者执行 `identity` preflight。
2. 在每台物理机器的 Chrome、Edge 环境各运行一次 device matrix；每次自动完成 8 个素材，所以两台机器共四次、最终仍是 32 条 trace：

   ```powershell
   npm run rive:g11:device-environment -- --browser=chrome --out=artifacts/rive-g11-formal/device-a-chrome.json
   npm run rive:g11:device-matrix -- --device-class=windows-10-plus-device-a --browser=chrome --environment=<environment.json> --host-config=artifacts/rive-g11-formal/host-config.json --out-dir=artifacts/rive-g11-formal/traces/windows-10-plus-device-a/chrome
   ```

   environment collector 通过实际 Chrome/Edge CDP、WebGPU adapter、WebGL2 renderer 和只保存 SHA-256 的 Windows machine identity 生成文件，不持久化原始 MachineGuid。runner 会先构建受忽略的 converter runtime、执行三 host preflight，再从 manifest 的官方不可变 URL 下载 8 个素材并逐项验证 byte length/SHA-256；若已下载，可用 `--source-dir=<directory>` 按官方原始文件名读取本地缓存。`.riv` 只进入系统临时目录，成功或失败后都删除。矩阵不会在首条 parity failure 后停止：8 项均尝试，最后以非零状态汇总失败数。每条已生成的 trace 保留全部 channel/RGBA artifact，并同时写出 `animation.hya`、`animation.hyapkg`、`conversion-manifest.json` 与 `conversion-report.json`；`artifacts/` 已由 Git 忽略，因此连续运行不会污染 clean source identity。
3. 在同一 clean revision 运行 `node scripts/benchmark/rive-g11-run-security.mjs --formal --out=artifacts/rive-g11-formal/security.json`。用 `npm run rive:g11:player-closure -- --formal --out-dir=artifacts/rive-g11-formal/player-closure` 实际启动 exact-HYA player，生成 deterministic tarball 和 HTTP network log；再用 `rive-browser-closure-scan.mjs --formal` 同时传入该 tarball、`examples/live2d-hya/bundle.js`、source map、network log。闭包报告会重新约束 Node.js 22+、clean revision、四项全通过和零禁止项；dirty diagnostic 报告不能被 collector 接受。
4. 运行 `npm run rive:g11:index -- --index=artifacts/rive-g11-formal/evidence-index.json --trace-dir=artifacts/rive-g11-formal/traces --closure=artifacts/rive-g11-formal/browser-closure.json`；首次运行会从受跟踪的空 index contract 初始化。collector 会重新执行 formal trace/closure validator、拒绝 revision/manifest/workload/RIV/device/browser 冲突，并从完整素材矩阵机械生成 device/browser aggregate 与 performance rows。可重复传入 `--trace=<relative-posix-trace.json>`；只有 32 条 trace/performance、两台不同物理机器各 Chrome/Edge，以及四项 closure 全部通过时 index 才变为 `complete`。
5. 运行 `npm run rive:g11:candidate -- --evidence-index=artifacts/rive-g11-formal/evidence-index.json --security=artifacts/rive-g11-formal/security.json --out=artifacts/rive-g11-formal/candidate.json`；generator 只从 formal corpus、指定 evidence index、指定 security report 和实际 artifact bytes 派生 blocker，并把 candidate 绑定到 index 的 SHA-256 与 byte length。
6. 两个设备 slot 均可使用任意 GPU，但必须是两台不同的 Windows 10 或更高版本物理机器；每台运行 Chrome 与 Edge。
7. 保持六个 production host 环境变量不变，运行 `npm run rive:g11:formal-closure -- --candidate=artifacts/rive-g11-formal/candidate.json --evidence-index=artifacts/rive-g11-formal/evidence-index.json --out=artifacts/rive-g11-formal/formal-closure.json`。只有 candidate 精确绑定所选 index、index 绑定同一 revision/manifest/workload、32 条 trace 与性能样本、28 个 security case、4 项 closure scan 和全部 corpus coverage 均通过时，记录才是 `formalEvidence: true`。

当前仓库中的 `rive-g11-formal-closure-attempt.json` 是失败尝试记录，不是 baseline。

正式 admission 不接受 capture 自报成功：contract 会拒绝 `oracle-proxy`、`metric-unavailable` 和不可用能耗源。当前 host 的 GPU energy 在 NVIDIA 设备上由 `nvidia-smi power.draw` 周期采样并梯形积分；官方 public WebGL2 API 尚未暴露可验证的 topology/draw-order oracle，WebGL2/WebGPU GPU timestamp query 也尚未接线，因此包含这两个诊断的 trace 必须保持 formal failed，不能被 collector 收录。
