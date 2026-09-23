# ADR 0105：UI 与 Engine 独立发布门禁

状态：接受。按用户要求，UI 的变更不再阻塞 Engine 库发布。

## 决策

本决策取代早期统一 Studio 发布范围中将 UI 纳入 Engine API、包预算和发布产物的安排；保留原 ADR 与历史评审资料。

- Engine 的库发布范围为本仓库的 engine、animation-spec、extensions、shader-language 四个 npm 包，以及 Engine 示例目录。
- UI 在独立仓库维护 API 快照、包预算、按需消费者测试、浏览器回归和版本号。原 55,000 B / 280,000 B / 60 文件及 button gzip 5,000 B 预算原值迁移。
- Engine 的 `release:check`、`:local`、`:global`、`release:artifact:check` 只调用本仓库发布检查。UI 的 API、版本、构建或测试不参与这些结果。
- `check:engine:fast` 包含类型、全部工作区单元测试、Engine 范围的原有契约与性能策略测试、包边界、引擎架构、renderer prepare、能力准入、文档、API、发布范围及 Shader Language 检查。
- `check:engine:slow` 保留 Engine 渲染、AO、Stage 14、完整 smoke/full 示例和 Engine CPU 案例。Editor 的两个 CPU 场景与游戏截图继续属于 Studio 集成范围。灯光 GPU 场景在 Engine 内保存与原场景字节/hash 一致的快照，保留 HTTP 路径及输入身份。slow CI 使用 Engine 范围入口。
- 原跨仓库结构/工作区/产品检查保留在 `check:studio:fast`、`check:studio:slow`；历史 `check:fast` / `check:slow` 入口维持兼容。应用打包入口为 `release:studio:artifacts`，不是 Engine 库发布前置条件。
- 文档检查只验证本仓库文件和源码映射；已登记的跨仓库链接由 `docs:studio:check` 校验。未知仓库外路径仍拒绝。

## 不变的约束

Engine 的 API 基线中只删除外部仓库所属项目、规范化路径分隔符，不接受其他导出变化。
Engine 的包、消费者和入口预算原值保留；正式性能比较、长时间 readback、AO、Shader Language 和 WebGPU 校验继续属于 local/global 发布计划。
既有 API、包体积和设备证据失败仍须处理，不能用本次拆分宣称 Engine 已达到发布条件。

## 验证

隔离测试在没有 UI 及 UI package.json 损坏时运行 Engine API/发布范围检查；结果必须一致。
测试还检查 Engine 自身 API 漂移与体积超标仍会失败、slow/full 场景完整保留、Studio 产品场景仍可选择。

当前结果见 [独立发布检查报告](../../../review/independent-library-release.md)。
