# ADR 0080：首发正确性按浏览器与真实硬件 WebGPU 验收

- 状态：Accepted
- 日期：2026-08-18
- 影响范围：0.1 浏览器/设备支持矩阵、M02 G02/G07、发布证据

## 背景

首发矩阵同时要求 Chrome/macOS、Chrome/Edge Windows 浏览器证据，以及 Apple integrated、
Windows integrated、Windows discrete 三类设备证据。浏览器证据已经记录真实 adapter、backend、
操作系统和 GPU validation/lifecycle 结果，再按集显类型重复设置 required 项，会让同一次正确性
重放被计算两次，并把是否能取得特定集显机器变成发布资格。

HaiYue 是 WebGPU-only 渲染引擎。0.1 的用户边界应明确要求可用的真实硬件 GPU，而不是承诺覆盖
每一种集显类别。软件 adapter、远程虚拟渲染或 backend fallback 仍不能形成发布证据。

## 决策

1. `config/release-matrix.json` 的 required correctness 以支持浏览器/操作系统为主轴；每项通过证据
   必须记录 native WebGPU、真实硬件 adapter、backend、浏览器与操作系统身份。
2. 删除 `apple-integrated` 与 `windows-integrated` 两个 required device class，不再为集显单独设置
   发布 handoff。Apple GPU 覆盖由 required `chrome-macos` 浏览器重放提供，不重复计数。
3. 0.1 的 Windows 硬件下限保留为 `windows-discrete` required device class；Chrome 和 Edge 必须在
   同一类真实独显上通过。首发不承诺 Windows 集显兼容性或性能。
4. WARP、SwiftShader、llvmpipe、软件/虚拟 adapter、RDP/ICA 等远程渲染不能满足 required evidence。
5. 渲染性能仍完全遵守 ADR 0073 的同机五引擎合同；`windows-discrete` 是正确性支持边界，不是指定
   型号的性能排名主机，也不产生固定 FPS 承诺。

## 后果

- M02 G07 不再等待 Apple/Windows 集显 handoff；仍必须补采当前 clean revision 的
  `chrome-macos` 正确性证据。
- Windows 10 22H2 Chrome/Edge 与真实独显仍为 required；Android/ChromeOS/Safari 保持 extended。
- 旧 `apple-integrated`、`windows-integrated` performance profile 和历史 artifact 只作为内部诊断，
  不再出现在 0.1 required correctness 集合中。

## 验证

- `node --test scripts/visual-regression/g02-browser-regression-policy.test.mjs`
- `node scripts/verify-m02-g02-candidate.mjs`
- `node scripts/verify-m02-g02-candidate.mjs --require-all-devices`
- `npm run render-product:check`

> 2026-08-18：[ADR 0081](./0081-windows-first-0-1-browser-support.md) 随后将 `chrome-macos` 调整为 extended；本 ADR 的真实硬件 WebGPU 与 Windows discrete 要求不变。
