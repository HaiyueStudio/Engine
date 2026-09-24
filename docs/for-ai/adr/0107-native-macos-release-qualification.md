# ADR 0107：Mac 与 Windows 原生 GPU 发布资格路径

- 状态：Accepted
- 日期：2026-09-23
- 部分替代：ADR 0072 的 Windows-only 发布硬件边界；Windows 最低版本不变。

用户明确允许使用 Mac 完成正式发布验证。`config/release-matrix.json` 的 `qualificationPaths`
是唯一资格定义：macOS 14+ Chrome/Metal，或 Windows 10 22H2+ Chrome 与 Edge/真实独显，完整满足其中一条即可。
`required` 表示所选路径内必须完成，不是强制同时拥有两种操作系统。报告必须明确所选路径，不能拿 Mac 证据声称 Windows 已通过。
Mac 可使用真实 Apple Silicon、Intel 或 AMD Metal GPU；软件、fallback、远程/虚拟 GPU 仍被拒绝。
原有固定设备性能预算保持诊断用途，不把 Intel/AMD Mac 冒充 Apple M4 档；性能排名仍来自同机跨引擎比较。

正式灯光证据必须来自干净提交和本地会话，绑定 revision、主机、OS/build、驱动、浏览器、GPU、Node、时间与完整 workload。
`verify:lighting-scaling` 生成单独的 diagnostic 文件；`verify:lighting-scaling:formal` 才写正式路径。
local/global release gate 都先采集和验证正式灯光证据。新 `ci-lighting.yml` 可选择原生 Mac 或 Windows self-hosted runner。
CI runner 的平台标签必须符合实际硬件；GitHub-hosted 或虚拟 GPU 不凭标签自动取得资格。

灯光测量保留 128 盏局部灯、4 view、720p、100% 动态、高重叠、8 CPU / 2 GPU 样本。
现有 Forward 总容量仍为 8。局部容量根据当前 view 实际提交的 ambient/directional 槽位计算；
被替换的全局灯也必须计入 overflow，不能用 authored 全局灯数量假定它们永远占用槽位。

Shader 预算的能力归因、实际测量和验证结果记录在[本轮发布评审](../../../review/release-0.2.0-shader-lighting.md)。
