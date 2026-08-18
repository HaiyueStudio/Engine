# ADR 0044：WebGPU-only 兼容契约

## 决策

Engine、Editor、内嵌 Player 与导出 Runtime 只支持 WebGPU，不实现或尝试 WebGL fallback。兼容状态通过 `HaiyueEngine.webGpuCompatibility` 使用同一套分类、文案和页面渲染器。

| 状态 | EngineError code | 是否终止 Runtime | 语义 |
| --- | --- | --- | --- |
| `unsupported` | `E_WEBGPU_UNSUPPORTED` | 是 | Runtime 没有 `GPU` 入口，例如浏览器未提供 `navigator.gpu` |
| `adapter-unavailable` | `E_WEBGPU_ADAPTER_UNAVAILABLE` | 是 | WebGPU 入口存在，但 `requestAdapter()` 没有返回 adapter |
| `context-unavailable` | `E_WEBGPU_CONTEXT_UNAVAILABLE` | 是 | Adapter/device 已取得，但目标 canvas 无法创建 WebGPU context，或 canvas 目标本身无效 |
| `optional-feature-degraded` | 无 | 否 | WebGPU 基础能力可用，仅可选 feature/renderer 不可用；必须记录 feature、reason 与 fallback |
| `supported` | 无 | 否 | 所需 WebGPU 路径完整可用 |

`requestDevice()`、shader 编译、资源加载等其他失败不得伪装成上述三种兼容错误，应保留原始错误域和恢复策略。

## 页面契约

三个致命状态使用相同的阻塞错误页面结构：产品名、WebGPU-only 标识、状态标题、解释、恢复建议和稳定错误码。页面必须明确没有 WebGL fallback。

`optional-feature-degraded` 使用相同视觉语言的非阻塞状态页，列出每个降级项及 fallback，并允许 Runtime 继续启动。普通错误仍走各 Runtime 原有错误通道，不能被兼容页面吞掉。

Editor、Player 和导出 Runtime 不再各自预检查 `navigator.gpu`。它们统一让 `HaiyueEngine.init()` 产生结构化错误，再使用兼容契约分类和显示；成功后则从 `engine.capabilities` 生成 supported/degraded 报告。

## API 边界

兼容能力附着在既有 `HaiyueEngine` 公共类的静态 `webGpuCompatibility` 门面上，不增加稳定根入口或 `@haiyue/engine/core` 的命名导出数量。这样既保持公共契约可发现，也不扩大黄金入口的 bundle/API 预算。
