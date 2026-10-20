# ADR 0117：0.2.1 原生硬件验收范围

- 状态：Accepted
- 日期：2026-10-06
- 决策来源：用户明确要求调整合同和门禁后继续 G09。
- 部分取代：[ADR 0107](0107-native-macos-release-qualification.md) 的 Intel 必需路径及 [ADR 0109](0109-deferred-lighting-021-contract.md) 的双设备验收要求；历史证据不重判。

## 决策

[release-matrix.json](../../../config/release-matrix.json) 统一拥有发布、G09 及后续 G05/G07 的硬件边界。完成其中一条完整路径：

1. Windows 10 22H2+，原生 NVIDIA/AMD 独显，Chrome **及** Edge。
2. macOS 14+，Apple Silicon 或 AMD 原生 Metal GPU，Chrome。

Intel Gen9 HD/UHD 630 等旧集显降为 extended 非阻塞兼容范围。保留其黑帧、GPU 重置、性能失败及未归因状态；该范围没有稳定性或性能达标承诺。Apple Silicon 仍属于支持路径，不按“集成 GPU”一词一并排除。扩展设备的手动诊断继续执行严格像素与资源断言，失败仍是失败。

powerPreference 只是请求提示，不能代替硬件身份、证明两块 GPU，或将 NVIDIA 标作旧 AMD runner。Windows 的两个浏览器必须分别核验产品身份、原生后端与一致的实际 GPU。自动门禁选择完整平台路径，不能只跑可用浏览器后报告完整通过。缺失浏览器、原生功能或数据保持失败。

## 性能与证据

这是支持范围的调整，不是性能豁免。保留所有原场景、质量、像素容差、零错误/残留、内存上限、小场景 5% 回归上限及 G05 独显预算。旧 Intel 预算和原报告作为扩展兼容历史保留，旧 AMD 性能失败也不自动通过。

新主机必须用实际身份登记，重新建立同机 A0/B4 配对；不能与旧 Mac CPU/GPU 样本拼接。沿用至少 120 帧预热、3 轮、每轮 300 CPU/300 GPU 样本、实际 120 秒冷却、完整失败人口和稳定性判定。主机观测按 OS 记录，Windows 不伪造 `pmset` 数值；缺少必要观测不能写成已通过热状态检查。未实现或未测的阶段保持 pending。

正确性通过仅解除该支持路径的性能采样阻塞。G09 仍须完成 F0–F8、固定旧生产版本 A0 与当前 B4 的对照、代表场景消融和至少一项真实可归因收益；G05 必须重验最终候选；G07 必须消费同一 clean revision。dirty、smoke、黑帧定位和资源开关消融均不能提升为正式性能或发布资格。

## 接线与迁移

G09 原生回归、裁剪、示例、读回设备生命周期和 A0/B4 黑帧入口共用平台策略，并在证据中记录新合同与配置哈希。新回归 schema 3 不接受旧 schema 2 或 portable 诊断冒充新合同。旧 G01/G05 冻结人口验证器保留原语义，作为历史审计入口；新硬件性能入口须使用新身份、完整配对和同等预算，不能将旧证据改标签。

当前实现与未完成项记录在 [G09 review](../../../review/engine-0.2.1/g09/README.md)，不修改已完成 Goal 与旧 Accepted ADR。
