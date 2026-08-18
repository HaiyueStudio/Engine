# ADR 0072：首发 Windows 最低支持 Windows 10 22H2

- 状态：Accepted
- 日期：2026-08-15
- 影响范围：首发浏览器支持矩阵、Windows 设备登记、M02 正式证据

## 背景

M02 原冻结范围要求 Windows 11 上的稳定 Chrome 和 Edge。当前后续开发主机只有 Windows 10
22H2（build 19045），且首发没有可用的 Windows 11 runner。用户明确决定把首发最低 Windows
版本下调到 Windows 10；WebGPU、浏览器稳定版、真实 GPU 和正式 evidence 要求不随之降低。

## 决策

1. 首发 required Windows 浏览器环境改为 Windows 10 22H2 或更高版本上的稳定 Chrome 和 Edge。
2. Windows integrated/discrete 仍是两个独立 required device class；必须从本地控制台运行，禁止
   RDP/ICA、WARP、SwiftShader、llvmpipe 或其他软件 adapter。
3. 集显登记仍要求 Intel Iris Xe/UHD 或 AMD Radeon integrated；独显登记仍要求 NVIDIA RTX
   20-series 或 AMD RX 6000-series 及以上。操作系统支持下调不把旧 GPU 自动登记为发布设备。
4. 正式 artifact 仍须绑定 clean revision、精确 Windows build、Chrome/Edge、adapter fingerprint、
   display driver、runner labels、完整 workload 和零 owner/GPU validation residual。
5. 当前 Windows 10/Pascal 诊断可以验证浏览器兼容性，但 Pascal 不满足独显档最低硬件，因此不能
   晋升为 `windows-discrete` 正式性能证据。

## 后果

- Windows 10 22H2 用户进入首发浏览器支持范围，Windows 11 继续作为更高版本被支持。
- 当前开发机的 OS 不再阻断 M02；其 GPU 档案、正式像素/截图和性能 evidence 仍然阻断发布。
- 不修改性能预算、required scenario、浏览器稳定通道或 WebGPU-only 产品边界。

> 2026-08-15：固定 GPU 型号对“正式性能证据”的限制已由 [ADR 0073](./0073-portable-cross-engine-performance-evidence.md) 取代；本 ADR 的 Windows 10 22H2、浏览器兼容性与 native WebGPU 要求继续有效。

> 2026-08-18：[ADR 0080](./0080-hardware-webgpu-browser-correctness-matrix.md) 进一步取消 Windows integrated required correctness 类别，并将 0.1 Windows 支持边界收敛为稳定 Chrome/Edge、真实独显与 native WebGPU；本 ADR 的 Windows 10 22H2 最低版本结论继续有效。
