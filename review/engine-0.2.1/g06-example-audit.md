# G06 多光源示例验收

日期：2026-09-29。状态：**passed / G06 complete**。范围：生产路径的交互正确性、诊断入口与工程集成；不授予 G05 性能资格。

## 实现

- `examples/deferred-lighting` 使用公共包入口和固定种子场景，包含多材质不透明物体、透明 PBR 球与自发光参照。
- 1/8/9/32/128/256/512/1024 点光源、三条渲染路径、运动/暂停/重置、分散/高重叠、逐灯开关与范围投影。第 9 灯快捷模式可直接观察其照明贡献。
- 实际 GPU G-buffer 与深度读回、深度重建世界坐标、实际 tile 灯数/完整灯表回退热力图。调试读回最多 2 Hz，退出调试恢复正常剔除策略。
- 显示实际策略/回退原因、CPU record、异步 GPU timestamp 与帧编号、帧间隔、Deferred 跟踪分配、上传/pass；Forward 槽位不足明确告知，不虚构等价加速比。
- 窄屏布局、固定最大渲染尺寸、取消与快速切换、resize、设备恢复和 pagehide 资源释放。

最小入口评审见 [API 准入记录](g06-example-api-review.md) 与 [ADR 0110](../../docs/for-ai/adr/0110-deferred-example-profile.md)。稳定根入口、包路径、版本与性能预算不变。

## 可重现验证

浏览器自动化使用共享 `runChromeWebGpuFixture` 的可选交互回调，保留统一 native Chrome、错误收集、HTTP 来源与临时 profile 清理。旧调用不启用回调。`artifacts/engine-0.2.1/g06/example-browser.json` 保存源码/构建输入 SHA256、Git 修订及 dirty 标记、实际 adapter、交互断言和清理结果；截图在相同目录。

打包验证候选隔离保存至 `artifacts/engine-0.2.1/g06/package/`。检查前后正式 `artifacts/release` 原件按 SHA256 恢复，不替换 G05/G07 发布证据。

## 资格边界

本轮浏览器检查是交互与像素正确性验证，不是冷却后的性能人口。界面瞬时值不可代替 P95 或正式 FPS。跨引擎、同机对照与设备分档预算已拆为 M18 G08 draft；G05 最新完整性能失败仍有效，G07 仍依赖 G05 与 G06。没有执行发布、tag 或 push。

## 验证结果

- Root typecheck、1,382 项工作区测试、完整生产 build 及 96 个 fresh 示例目标通过。
- 4 项 facade/模型定向测试、7 项 catalog 测试、5 项共享 Chrome runner 测试通过。
- API baseline、486 模块边界、责任边界、21 renderer/10 post-process prepare 合同、文档及 milestones 检查通过。
- Chrome 154 / native Metal / AMD RDNA1：25 项浏览器检查通过，consoleError/exception/unclassifiedFailure 均为 0。
- 128 灯参考/Tiled 截图平均差异 0；第 9 灯开关改变 5,845 个像素；Forward 容量差异可见。全部八档灯数实际提交校验通过。
- 实际 timestamp 读数可用；该瞬时值只用于验证界面，不是性能结论。8 个 G-buffer/深度通道、实际 tile 溢出、快速切换、运动和移动布局通过。
- dispose 后跟踪 GPU resources=0、estimatedBytes=0，浏览器临时 profile 清理通过。
- `verify-engine-package`：确定性 tarball、真实安装、浏览器 bundle、Node/TypeScript/exports/CLI/来源检查通过；原正式发布证据逐文件 SHA256 恢复通过。候选报告内部保留原生成路径，实际本轮副本在 `g06/package/`，不应回指恢复后的 `artifacts/release/` 作为本轮证据。

完整命令日志：`artifacts/engine-0.2.1/g06/checks/`。浏览器与包报告均标记 dirty development 工作树，不能当作 clean release candidate。
