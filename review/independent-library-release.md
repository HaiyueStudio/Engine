# 独立库发布门禁检查

后续更新：用户已将新增能力纳入 0.2.0，API 与包体预算已重新评审，见 [0.2.0 能力预算记录](release-0.2.0-capability-budgets.md)。下文保留拆分时的测量状态。

日期：2026-09-23。Engine 仍在 `release/0.1.1`，版本号不变；本次未发布。

## 已完成

- Engine API 基线、能力预算、tarball 与消费者检查只包含本仓库四个公开包。
- Engine 发布 manifest 为四个 npm 包和一个示例目录；原 Studio manifest 保留为历史记录。
- UI 在自己的仓库维护 API 和原有体积预算，候选版本为 0.1.2。
- Engine 发布命令改走 `check:engine:fast` / `check:engine:slow`；原跨仓库工作流保留为显式 Studio 集成检查。
- Engine CPU 场景、四项引擎截图、smoke/full 示例及现有 GPU 检查保留；Editor 的两项 CPU 场景和游戏截图仍在 Studio 工作流。Engine CPU 诊断输出使用独立文件，不能覆盖 Studio baseline。
- Engine 入口字节预算从应用打包检查移至库发布检查，数值不变。
- 灯光 GPU 场景改用 Engine 内固定副本：与原 Games 文件的 363,097 字节和 SHA-256 完全一致，HTTP 路径及测量输入保持一致。现在该门禁也不需要 Games checkout。
- Engine slow CI 改走 `check:engine:slow`；保留 Studio 集成命令供显式调用。
- 文档决策见 [ADR 0105](../docs/for-ai/adr/0105-independent-library-release-gates.md)。

## 验证

- 发布策略及隔离测试：33 项通过。
- 路由测试：14 项通过；benchmark policy：30 项通过。
- UI 缺失 / package.json 损坏时，Engine API 结果一致，release scope 校验通过。
- 临时测试基线中注入 Engine API 差异，仍会被拒绝；入口超预算仍会失败。
- UI `release:check` 通过：25 个 Node 测试、6 个浏览器测试、6 个 Pages 页面；UI 报告位于独立 UI 仓库 `review/release-0.1.2.md`。
- Engine 全仓类型检查通过；1,284 项单元/契约测试通过。四个库构建完成。
- `check:engine:contracts`、工作区/模块边界、文档检查通过；隔离测试在没有任何兄弟仓库时执行结构与文档检查成功。
- 完整 `npm run build` 在 `live2d-hya` 示例构建超过现有 60 秒上限后失败，尚未完成全部 92 个示例；未提高超时。
- `verify:engine-package` 实际打包与消费者检查只涉及四个 Engine 包，仍有四项既有体积超限：animation-spec 130,278 B > 125,000 B；extensions 解包 2,651,601 B > 2,500,000 B；animation 消费者 gzip 223,060 B > 120,000 B；HYA state machine 消费者 gzip 230,623 B > 130,000 B。
- 性能策略测试 114/115 通过，唯一失败为缺少 `artifacts/webgpu/lighting-scaling.json`。未伪造正式设备证据。
- UI 与 Engine 之外的所有 API/包预算配置与拆分前逐项一致。

## 仍然阻止 Engine 发布的问题

API 检查已不受 UI `./expandable` 影响，但暴露出 Engine 自身未进入基线的导出：
`AnimationTextStyleRun`、音频 mixer、多玩家输入、`GuiFontOptions` 和 extensions interaction runtime 等。
本次只调整所有权和路径分隔符，不擅自接受这些 API 变化。

此前的包/消费者体积、Shader Language WGSL 成本、灯光正式 GPU 证据和 corpus 缓存问题仍需处理，见
[0.1.1 候选报告](release-0.1.1.md)。本次不放宽任何预算，不据 UI 就绪宣称 Engine 已可发布。
原 `check:fast` / `check:slow` 仍为 Studio 集成入口，可能要求兄弟仓库依赖；这两个旧入口不再是 Engine 库发布依赖。

## 本地证据

检查日志位于 `artifacts/release/independence-checks/`。它们属于本机未提交工作树检查，不是正式发布 runner 证据。
本次未执行 Engine 完整 GPU/cross-engine 发布矩阵，也未执行发布或推送。UI 和 Engine 的变更分别保留在各自仓库供评审。
