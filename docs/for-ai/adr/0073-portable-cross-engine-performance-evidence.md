# ADR 0073：渲染性能改用同机跨引擎可移植证据

- 状态：Accepted
- 日期：2026-08-15
- 影响范围：M02 G04/G07、release gate、性能文档、依赖锁定

## 背景

旧 M02 性能发布合同要求 Apple integrated、Windows integrated 和 Windows discrete 三类固定设备分别登记并重采绝对预算。仓库迁移到 Windows 10 后，指定 Apple 和新一代 Windows GPU 不再可用；旧证据又无法绑定当前 revision。继续把指定硬件作为性能发布前置条件，会让发布结论取决于能否取得设备，而不是当前引擎相对同类产品的实际表现。

同时，旧 benchmark 只比较 HaiYue 自身历史数据，能够发现退化，却不能回答在同等渲染内容下相对 Three.js、Babylon.js、Galacean 和 PlayCanvas 是否具有竞争力。

## 决策

1. 新增独立的 `performance-comparison/`，固定同一场景合同、viewport、DPR、对象/三角形/材质/灯光数量、warmup、样本和 cohort；五个引擎必须在同一主机与浏览器运行中采样。
2. HaiYue、Three.js、Babylon.js 与 PlayCanvas 使用 native WebGPU 并进入主排名。Galacean 当前稳定运行时为 WebGL2，其结果必须采集但单列，不进入 WebGPU 排名。
3. 正式判定要求结构 parity、独立截图 sanity、零浏览器错误、原始样本与三轮 cohort 完整，并要求 HaiYue median P50 领先或处于最快 WebGPU 对手 5% 以内。跨轮 P50 的 RSD 超过 15% 时默认判为不确定；只有 HaiYue 最慢一轮仍处于任一合格对手最快一轮的 5% 以内时，才以这一更保守的稳健领先条件放行。
4. 不再要求性能证据来自某个 GPU 型号。artifact 仍记录精确 OS、CPU、浏览器、浏览器可公开的 adapter 信息、backend、依赖版本、revision、dirty 状态和浏览器实际读取的源文件 hash；软件 adapter 或 backend fallback 自动失败，评审中确认的远程/虚拟渲染也不得晋升正式证据。
5. `config/webgpu-performance-budgets.json`、Node benchmark、AO/reflection/readback/editor memory 等保留为内部绝对预算、正确性、生命周期和退化诊断，不再作为“缺少某个固定硬件”形式的发布性能阻断。
6. M02 local/global release gate 都在当前 native WebGPU 主机运行三轮 portable full comparison。正式运行必须来自 clean revision；候选数据不自动晋升 baseline。
7. HYA、glTF/editor cold-start、editor interaction long-task 等专项中的绝对毫秒继续完整采集并输出跨历史基线诊断，但跨主机绝对值不再直接阻断发布；专项的 fidelity、结构、流式交付、解析相对加速、资源残留和错误仍是硬门禁。渲染性能发布结论只由同机跨引擎 full comparison 给出。

## 后果

- 当前 Windows 10 主机可以生成有意义的候选和正式渲染性能证据，不因 GPU 型号不是预登记型号而失败。
- required 浏览器/设备兼容性与产品正确性覆盖仍保留；本 ADR 只取消固定硬件对性能排名的垄断，不把一台机器的结果描述为所有硬件的绝对帧率承诺。
- 跨版本比较必须锁定外部引擎版本；升级任一对手依赖后需要重采完整同机报告。
- 本 ADR 取代 ADR 0072 中“Pascal 不能形成正式性能证据”的性能限定；Windows 10 22H2 最低支持、native WebGPU 和软件 adapter 禁令不变。

## 验证

- `npm run performance:compare:test`
- `npm run performance:compare:full`
- `npm run render-product:structure`
- `node --test scripts/release-gate-policy.test.mjs`

> 2026-08-18：[ADR 0080](./0080-hardware-webgpu-browser-correctness-matrix.md) 取消集显作为独立 required correctness 类别；本 ADR 的可移植性能合同不变。
