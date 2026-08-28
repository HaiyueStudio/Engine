# ADR 0090：Rive 正式素材使用多 evidence role 与 revision-pinned production adapter

- 状态：Accepted
- 日期：2026-08-25
- 补充：ADR 0087、ADR 0088、ADR 0089
- 兼容 tuple：`rive-7.3-webgl2-2.40.0`

## 背景

G11 原契约把 `feature-isolated`、`real-product`、`combined-stress` 当成素材互斥 kind。一个官方 `.riv` 实际可以同时覆盖某个 feature family、一个产品工作流和 combined stress；要求为每种证明意图复制素材会扩大下载与设备 trace 矩阵，却不会增加独立行为证据。

同时，differential runner 已冻结 channel、workload 与 validator，但真实 capability evaluator、official WebGL2 capture 和 exact-HYA WebGPU capture 需要由设备侧可执行宿主提供。仓库不能在宿主缺失时用相同 mock 数据填充两端。

## 决策

1. `formalAssets` 是不可变输入分母；`evidenceRoles` 是证明意图分母。一个素材可拥有多个唯一 role，但正式 trace 仍按素材 × 设备 × 浏览器执行一次完整 workload，不能按 role 裁剪。
2. `feature-witness` 必须引用该素材由冻结 census 机械归因的 feature family；`product-witness` 必须满足 product case 的全部 required family；每个 role 必须列出 pinned scenario 实际执行的 action kind。
3. 正式 minimum 改为 witness count：8 个 feature witness、4 个 product witness、3 个 combined-stress witness。legacy `kind` 仅保留输入历史分类，不再决定这些 minimum。
4. production adapter 采用 `haiyue-rive-production-adapter@1` 可执行宿主协议。三类宿主都必须返回与调用完全相同的 revision descriptor；二进制以有界字节字段传输，超时、输出上限、abort、重复 artifact path 和 descriptor 改写均为硬失败。
5. candidate generator 只从 `rive-g11-evidence-index.json`、真实 artifact bytes 和 formal corpus validator 派生 blocker。不得用固定字符串代替 trace/device/performance/closure 缺口，也不得把 collecting index 晋升为正式证据。
6. 每条 differential trace 必须保存 capability evaluator、official capture 与 HYA capture 的完整 revision descriptor。official/HYA capture host 还必须各自返回实际执行的 browser/device environment；两端与请求环境任一不一致都在写 trace 前失败。
7. 仓库提供通用 `rive-production-host.mjs` gateway。gateway 的 capability descriptor 同时绑定 gateway bytes 与 evaluator provider bytes；capture descriptor 绑定对应 provider bytes。provider 改动而 descriptor/config 未重生成时，`identity` 握手失败。
8. formal closure 不能把六个非空环境字符串当作 host 已配置。它必须实际执行三类 host 的 `identity` operation，核对 kind、descriptor 和 revision；可用 `RIVE_PRODUCTION_HOST_CONFIG_PATH` 指向由仓库生成器创建的单一配置文件。

## 后果

- 当前 8 个官方素材承担 19 个 role，并覆盖 8/8 feature family、4/4 product case 与 3 个 combined-stress witness；没有新增或 vendoring `.riv`。
- production bridge 完成并不等于 native host 或 parity 已通过。缺少 host、Node 22、clean revision、任一物理设备或任一 trace 时，正式闭环仍失败。
- gateway/provider hash 与 identity preflight 只证明实际调用的是指定 host bytes；provider 仍必须实现真实 full-fidelity capability evaluation 或 native browser capture，不能返回 mock/echo channel 数据。
- evidence index 可由两台设备分别积累，但 `complete` 必须绑定同一 Engine revision、manifest hash 和 workload plan hash；candidate validator 会重新读取并散列所有引用 artifact。
