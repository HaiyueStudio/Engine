# Rive production differential adapter

G11 的 production runner 不内置或模拟 Rive/HYA 两端结果。三个 revision-pinned 可执行宿主通过 `haiyue-rive-production-adapter@1` 协议接入：

| Host | Required environment |
| --- | --- |
| capability evaluation | `RIVE_CAPABILITY_EVALUATOR_COMMAND`、`RIVE_CAPABILITY_EVALUATOR_DESCRIPTOR_JSON` |
| official `@rive-app/webgl2@2.40.0` / WebGL2 capture | `RIVE_OFFICIAL_CAPTURE_COMMAND`、`RIVE_OFFICIAL_CAPTURE_DESCRIPTOR_JSON` |
| exact-HYA / WebGPU capture | `RIVE_HYA_CAPTURE_COMMAND`、`RIVE_HYA_CAPTURE_DESCRIPTOR_JSON` |

每类 host 可选 `*_ARGS_JSON`、`*_TIMEOUT_MS` 和 `*_MAX_OUTPUT_BYTES`。command 直接执行，不经过 shell。stdin 是单个 JSON envelope；`Uint8Array` 编码为 `{ "$haiyueBytesBase64": "..." }`。host 必须返回相同 `protocol`、`operation`、完整相同的 `descriptor`、`status: "completed"` 和 `result`。capture result 的 `artifactBytesByPath` 是 `[path, bytes]` 数组。

bridge 拒绝 descriptor substitution、重复 artifact path、cycle、abort 后结果、timeout、非零退出、无效 JSON 与超过上限的 stdout。runner 随后独立重算 11 个 channel comparison；host 的 pass/fail 结论不被直接信任。

正式收集顺序：

1. 在 Node 22、clean Engine revision 上配置三个 host。
2. 每台要求的物理设备分别运行 `rive-run-differential-trace.mjs --formal`，把 trace、设备、性能和 closure 引用合并进 `review/candidates/rive-g11-evidence-index.json`。
3. 运行 `npm run rive:g11:candidate`；generator 只从 formal corpus、evidence index 和实际 artifact bytes 派生 blocker。
4. 运行 `npm run rive:g11:formal-closure`。只有 index 绑定同一 revision/manifest/workload、32 条 trace 与性能样本、28 个 security case、4 项 closure scan 和全部 corpus coverage 均通过时，记录才是 `formalEvidence: true`。

当前仓库中的 `rive-g11-formal-closure-attempt.json` 是失败尝试记录，不是 baseline。
